// Exact-response cache: key canonicalization, hit/miss, single-flight, caps.

import { test } from "bun:test";
import assert from "node:assert/strict";
import { ResponseCache } from "../src/cache.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function source(body: string, init?: { status?: number; cacheable?: boolean; ctype?: string }) {
  return () => Promise.resolve({
    status: init?.status ?? 200,
    ctype: init?.ctype ?? "application/json",
    upstream: new Response(body, { status: init?.status ?? 200 }),
    cacheable: init?.cacheable ?? true,
  });
}

test("key canonicalizes object order and tracks real changes", () => {
  const c = new ResponseCache({ enabled: true });
  const a = c.key('{"b":1,"a":2}');
  const b = c.key('{"a":2,"b":1}');
  assert.ok(a);
  assert.equal(a, b);
  assert.notEqual(a, c.key('{"a":2,"b":1,"model":"x"}'));
  assert.equal(c.key("not json"), null);
});

test("key is stable across nested key order and array-preserving", () => {
  const c = new ResponseCache({ enabled: true });
  assert.equal(
    c.key('{"messages":[{"content":"hi","role":"user"}],"stream":false}'),
    c.key('{"stream":false,"messages":[{"role":"user","content":"hi"}]}'),
  );
  assert.notEqual(
    c.key('{"messages":[{"role":"user"},{"role":"assistant"}]}'),
    c.key('{"messages":[{"role":"assistant"},{"role":"user"}]}'),
  );
});

test("miss then hit returns the stored body and builds once", async () => {
  const c = new ResponseCache({ enabled: true });
  let built = 0;
  const produce = () => { built++; return source("hello")(); };

  const first = await c.run("k", produce);
  assert.equal(first.hit, false);
  if (first.hit) return;
  assert.equal(first.status, 200);
  assert.equal(await new Response(first.stream).text(), "hello");
  const payload = await first.done;
  assert.ok(payload);
  assert.equal(dec.decode(payload.body), "hello");

  const second = await c.run("k", produce);
  assert.equal(second.hit, true);
  if (!second.hit) return;
  assert.equal(dec.decode(second.payload.body), "hello");
  assert.equal(built, 1);
  assert.deepEqual(
    { hits: c.stats().hits, misses: c.stats().misses, entries: c.stats().entries },
    { hits: 1, misses: 1, entries: 1 },
  );
});

test("concurrent requests on one key build once", async () => {
  const c = new ResponseCache({ enabled: true });
  let built = 0;
  const produce = () => { built++; return source("body")(); };

  const [a, b] = await Promise.all([c.run("k", produce), c.run("k", produce)]);
  assert.equal(built, 1);
  const payloads = await Promise.all([a.hit ? null : a.done, b.hit ? null : b.done]);
  assert.ok(payloads.some((p) => p && dec.decode(p.body) === "body"));
  assert.equal(c.stats().hits, 1);
  assert.equal(c.stats().misses, 1);
});

test("bodies over maxBytes are not stored", async () => {
  const c = new ResponseCache({ enabled: true, maxBytes: 4 });
  let built = 0;
  const produce = () => { built++; return source("hello world")(); };

  const first = await c.run("k", produce);
  assert.equal(first.hit, false);
  if (first.hit) return;
  assert.equal(await first.done, null);
  assert.equal(await new Response(first.stream).text(), "hello world");

  const second = await c.run("k", produce);
  assert.equal(second.hit, false);
  assert.equal(built, 2);
  assert.equal(c.stats().entries, 0);
});

test("entries expire after the ttl", async () => {
  let clock = 1_000;
  const c = new ResponseCache({ enabled: true, ttlMs: 100, now: () => clock });
  let built = 0;
  const produce = () => { built++; return source("x")(); };

  const first = await c.run("k", produce);
  if (!first.hit) await first.done;
  clock = 1_100;
  const fresh = await c.run("k", produce);
  assert.equal(fresh.hit, true);

  clock = 1_300;
  const stale = await c.run("k", produce);
  assert.equal(stale.hit, false);
  assert.equal(built, 2);
});

test("maxEntries evicts oldest first", async () => {
  const c = new ResponseCache({ enabled: true, maxEntries: 2 });
  for (const k of ["a", "b", "c"]) {
    const r = await c.run(k, source(k));
    if (!r.hit) await r.done;
  }
  assert.equal(c.stats().entries, 2);
  assert.equal((await c.run("a", source("a"))).hit, false);
  assert.equal((await c.run("c", source("c"))).hit, true);
});

test("enabled=false never stores but still yields the body", async () => {
  const c = new ResponseCache({ enabled: false });
  let built = 0;
  const produce = () => { built++; return source("hey")(); };

  const first = await c.run("k", produce);
  assert.equal(first.hit, false);
  if (first.hit) return;
  assert.equal(await dec.decode((await first.done)!.body), "hey");
  assert.equal(await new Response(first.stream).text(), "hey");

  const second = await c.run("k", produce);
  assert.equal(second.hit, false);
  assert.equal(built, 2);
  assert.equal(c.stats().entries, 0);
});

test("non-cacheable responses are drained but not stored", async () => {
  const c = new ResponseCache({ enabled: true });
  const r = await c.run("k", source('{"error":"cap"}', { status: 429, cacheable: false }));
  assert.equal(r.hit, false);
  if (r.hit) return;
  assert.equal(r.status, 429);
  assert.equal(await r.done, null);
  assert.equal(await new Response(r.stream).text(), '{"error":"cap"}');
  assert.equal(c.stats().entries, 0);
});
