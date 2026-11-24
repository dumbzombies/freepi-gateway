// Exact-response cache for completions, per isolate. Byte-identical requests
// reuse the upstream body instead of paying for another turn. Streaming is
// preserved on a miss: the upstream body is split, the client branch goes out
// untouched, and the local branch is drained to produce the stored bytes (and
// the usage figures the handlers parse).
//
// Isolates recycle freely on Workers, so this cache is best-effort by design —
// a recycle costs only the entries, never correctness.

export interface CachedPayload {
  status: number;
  ctype: string;
  body: Uint8Array;
}

export interface CacheOptions {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  maxBytes: number;
  now?: () => number;
}

export type CacheRun =
  | { hit: true; payload: CachedPayload }
  | {
    hit: false;
    status: number;
    ctype: string;
    stream: ReadableStream<Uint8Array>;
    /** resolves with the storable payload, or null when nothing was stored */
    done: Promise<CachedPayload | null>;
  };

export interface CacheSource {
  status: number;
  ctype: string;
  upstream: Response;
  cacheable: boolean;
}

interface Entry {
  payload: CachedPayload;
  createdAt: number;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
}

export class ResponseCache {
  enabled: boolean;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<CachedPayload | null>>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(opts?: Partial<CacheOptions>) {
    this.enabled = opts?.enabled ?? true;
    this.ttlMs = opts?.ttlMs ?? 3_600_000;
    this.maxEntries = opts?.maxEntries ?? 300;
    this.maxBytes = opts?.maxBytes ?? 8 * 1024 * 1024;
    this.now = opts?.now ?? Date.now;
  }

  /** Exact cache key for a request body, or null when the body is not JSON.
   * Hashes the raw text: canonicalizing large prompts costs CPU the free tier
   * does not have, and a retry normally sends byte-identical bodies anyway. */
  async key(bodyText: string): Promise<string | null> {
    try {
      JSON.parse(bodyText);
    } catch {
      return null;
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("v1\n" + bodyText));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  stats(): { hits: number; misses: number; entries: number; bytes: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.entries.size,
      bytes: this.bytes,
      hitRate: total ? this.hits / total : 0,
    };
  }

  private lookup(key: string): CachedPayload | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(key);
      this.bytes -= entry.payload.body.byteLength;
      return null;
    }
    // refresh LRU position
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.payload;
  }

  private store(key: string, payload: CachedPayload): void {
    const size = payload.body.byteLength;
    if (size > this.maxBytes) return;
    this.entries.set(key, { payload, createdAt: this.now() });
    this.bytes += size;
    // LRU cap
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const e = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (e) this.bytes -= e.payload.body.byteLength;
    }
    // byte cap
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const e = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (e) this.bytes -= e.payload.body.byteLength;
    }
  }

  async run(key: string, produce: () => Promise<CacheSource>, opts?: { store?: boolean }): Promise<CacheRun> {
    const caching = this.enabled && opts?.store !== false;

    if (caching) {
      const cached = this.lookup(key);
      if (cached) {
        this.hits++;
        return { hit: true, payload: cached };
      }

      const pending = this.inflight.get(key);
      if (pending) {
        const payload = await pending.catch(() => null);
        if (payload) {
          this.hits++;
          return { hit: true, payload };
        }
        // first attempt was uncacheable or failed: build this one normally
      }
    }

    this.misses++;
    const { promise: done, resolve: settle } = Promise.withResolvers<CachedPayload | null>();
    if (caching) {
      // Register the single-flight promise before producing, so a concurrent
      // identical request waits for this build instead of paying for its own.
      this.inflight.set(key, done);
      void done.then(() => {
        if (this.inflight.get(key) === done) this.inflight.delete(key);
      });
    }

    let src: CacheSource;
    try {
      src = await produce();
    } catch (e) {
      settle(null);
      throw e;
    }
    const { status, ctype } = src;
    const body = src.upstream.body;

    if (!body) {
      const payload: CachedPayload = { status, ctype, body: new Uint8Array(0) };
      settle(payload);
      return { hit: false, status, ctype, stream: emptyStream(), done };
    }

    // Split so the client keeps streaming while we drain our own branch.
    const [stream, drain] = body.tee();

    void (async () => {
      try {
        const reader = drain.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done: fin, value } = await reader.read();
          if (fin) break;
          if (value) {
            chunks.push(value);
            size += value.byteLength;
            if (size > this.maxBytes) { void reader.cancel(); break; }
          }
        }
        const payload: CachedPayload = { status, ctype, body: concat(chunks, size) };
        if (caching) this.store(key, payload);
        settle(payload);
      } catch {
        settle(null);
      }
    })();

    return { hit: false, status, ctype, stream, done };
  }
}
