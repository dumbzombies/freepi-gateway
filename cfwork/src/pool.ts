// Account pool and turn execution: walks the configured accounts in order,
// answering every upstream gate in place (ads pause, session reset, spent
// session rotation) and handing account-level gates (hourly ceiling, credits
// exhausted) to the next account instead of ending the request.
//
// Gate semantics are verified against free-pi-cli 0.6.19 behaviour:
// - ads: one impression pair per turn keeps the ads gate from tripping; the
//   impression record lands asynchronously, so a chat fired the same instant
//   still reads the session as ad-less — hence the 400 ms beat.
// - a tripped ads gate can answer 200 with a fake "out of date" completion
//   (prompt_tokens 0); JSON-only check, never read a streaming body.
// - concurrent_session (409 or 429): /session/reset releases the occupied
//   slot, then retry once.
// - account-level gates (ads_required, hourly_ceiling, credits_exhausted,
//   daily_ceiling, quota_exhausted): only another account can answer.

import { AD_WARM_DELAY_MS } from "./config.ts";
import type { Upstream } from "./upstream.ts";

/** Session-level rejections. Deliberately excludes `concurrent_session`, which
 * is about the account's slot count — rotating more sessions would only make
 * that worse (reset handles it instead). */
const SESSION_EXHAUSTED =
  /session[\s_-]*(?:is[\s_-]*)?too[\s_-]*long|session_too_long|session[\s_-]*(?:token[\s_-]*)?(?:limit|budget|quota|cap)\b|session[\s_-]*(?:exhausted|spent)/i;

/** The friendly message for the account's 4-concurrent-session cap — the one
 * failure an agent can fix itself, so name it instead of passing the raw
 * upstream text through. */
export const SESSION_LIMIT_MESSAGE =
  "free-pi allows 4 concurrent sessions per account. Close another free-pi CLI/proxy session, then retry.";

export function isSessionTooLong(status: number, body: string): boolean {
  if (status < 400) return false;
  if (/concurrent[\s_-]*session/i.test(body)) return false;
  return SESSION_EXHAUSTED.test(body);
}

/** The account-level gates that only another account can answer. */
const ACCOUNT_GATES = ["ads_required", "hourly_ceiling", "credits_exhausted", "daily_ceiling", "quota_exhausted"];

function isAccountGate(text: string): boolean {
  return ACCOUNT_GATES.some((gate) => text.includes(gate));
}

function isConcurrentSession(text: string): boolean {
  return /concurrent[\s_-]*session/i.test(text);
}

/** Fake-200 marker: a tripped ads gate answers 200 with a completion that
 * reports "out of date" and zero prompt tokens. */
function isFakeOutOfDate(text: string): boolean {
  return text.includes('"prompt_tokens":0') && /shows ads|out of date/i.test(text);
}

/** Rebuild a Response whose body was consumed for classification. */
function replayed(res: Response, body: string): Response {
  const headers = new Headers();
  const ctype = res.headers.get("content-type");
  if (ctype) headers.set("content-type", ctype);
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

export interface Account {
  jwt: string;
  /** One session per account for the isolate's lifetime, like one CLI
   * session; the ads gate tracks impressions per session, so ads and chat
   * must share this id. */
  sessionId: string | null;
}

/** Per-isolate account state, keyed by JWT so a re-read of the same secret
 * keeps its session id. */
export class AccountPool {
  readonly byJwt = new Map<string, Account>();

  /** Parse FREEPI_TOKENS (JSON array, or newline/comma/space separated) plus
   * the two-account FREEPI_TOKEN / FREEPI_TOKEN_ALT shapes. */
  static tokensOf(env: { FREEPI_TOKENS?: string; FREEPI_TOKEN?: string; FREEPI_TOKEN_ALT?: string }): string[] {
    const out: string[] = [];
    const add = (value: string | undefined) => {
      if (!value) return;
      const text = value.trim();
      if (!text) return;
      let parts: string[];
      if (text.startsWith("[")) {
        try {
          const parsed: unknown = JSON.parse(text);
          parts = Array.isArray(parsed) ? parsed.map(String) : [text];
        } catch {
          parts = text.split(/[\s,]+/);
        }
      } else {
        parts = text.split(/[\s,]+/);
      }
      for (const part of parts) {
        const token = part.trim().replace(/^["']|["']$/g, "");
        if (token && !out.includes(token)) out.push(token);
      }
    };
    add(env.FREEPI_TOKENS);
    add(env.FREEPI_TOKEN);
    add(env.FREEPI_TOKEN_ALT);
    return out;
  }

  account(jwt: string): Account {
    let acct = this.byJwt.get(jwt);
    if (!acct) {
      acct = { jwt, sessionId: null };
      this.byJwt.set(jwt, acct);
    }
    return acct;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One account's chat with every gate answered in place: an ad impression
 * before the request, a spent-session rotation, the ads gate re-warming and
 * asking once more, and the session gate resetting and asking once more.
 * Returns the upstream Response, or null when this account cannot serve the
 * request and the pool should move on. */
export async function sendWithGates(
  upstream: Upstream,
  acct: Account,
  body: string,
  signal: AbortSignal | undefined,
): Promise<Response | null> {
  const send = async (): Promise<Response> => {
    const turnId = crypto.randomUUID();
    if (!acct.sessionId) acct.sessionId = crypto.randomUUID();
    await upstream.warmAds(acct.jwt, acct.sessionId, turnId);
    // The upstream records impressions asynchronously: a chat fired the same
    // instant still reads the session as ad-less, so give the record a beat.
    await sleep(AD_WARM_DELAY_MS);
    return upstream.completions(acct.jwt, body, acct.sessionId, turnId, signal);
  };

  let res = await send();

  // Session spent (context/token budget): the session itself is spent, not
  // the request. Retire it and replay on a fresh one — what makes compaction
  // work again for long agent runs.
  if (res.status >= 400) {
    const text = await res.text().catch(() => "");
    if (isSessionTooLong(res.status, text)) {
      acct.sessionId = crypto.randomUUID();
      res = await send();
    } else {
      res = replayed(res, text);
    }
  }

  if (res.status === 403) {
    const probe = await res.text();
    if (probe.includes("ads_required")) {
      res = await send(); // rewarm and ask once more
    } else {
      res = replayed(res, probe);
    }
  }

  // 0.6.19+: a tripped ads gate can answer 200 with a fake "out of date"
  // completion (prompt_tokens 0). JSON-only check — never read a streaming body.
  if (res.status === 200 && !(res.headers.get("content-type") || "").includes("text/event-stream")) {
    const probe = await res.clone().text();
    if (isFakeOutOfDate(probe)) {
      await sleep(AD_WARM_DELAY_MS * 2);
      res = await send();
    }
  }

  if (res.status === 409 || res.status === 429) {
    const probe = await res.text();
    if (isConcurrentSession(probe)) {
      await upstream.resetSession(acct.jwt);
      res = await send();
      if (res.status === 409 || res.status === 429) {
        const again = await res.text().catch(() => "");
        // still occupied: let the pool try another account
        if (isConcurrentSession(again)) return null;
        res = replayed(res, again);
      }
    } else {
      res = replayed(res, probe);
    }
  }

  return res;
}

export interface PoolWalkResult {
  /** the response that should go back to the client (ok or final error) */
  response: Response;
  /** the account that produced it, when one did */
  jwt: string | null;
}

/** Walk the pool in order: each account gets a warm + chat + in-place gate
 * handling, and an account-level gate passes the request to the next one
 * instead of ending the request. */
export async function chatAcrossPool(
  upstream: Upstream,
  accounts: Account[],
  body: string,
  signal: AbortSignal | undefined,
): Promise<PoolWalkResult> {
  let last: Response | null = null;
  let lastJwt: string | null = null;
  let sawConcurrentSession = false;
  for (const acct of accounts) {
    let res: Response | null;
    try {
      res = await sendWithGates(upstream, acct, body, signal);
    } catch {
      continue; // this account is unreachable; the pool may still answer
    }
    if (!res) {
      // concurrent_session survived the reset on this account; remember it so
      // an all-accounts-occupied walk can still report the real cause.
      sawConcurrentSession = true;
      continue;
    }
    if (res.ok) return { response: res, jwt: acct.jwt };

    const text = await res.text().catch(() => "");
    if (res.status !== 403 && res.status !== 429) {
      return {
        response: new Response(text || JSON.stringify({ error: { message: `upstream HTTP ${res.status}`, type: "freepi_proxy_error" } }), {
          status: res.status,
          headers: { "content-type": "application/json" },
        }),
        jwt: acct.jwt,
      };
    }
    if (!isAccountGate(text)) {
      return {
        response: new Response(text, { status: res.status, headers: res.headers }),
        jwt: acct.jwt,
      };
    }
    last = new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
    lastJwt = acct.jwt;
  }
  if (last) return { response: last, jwt: lastJwt };
  if (sawConcurrentSession) {
    return {
      response: Response.json(
        { error: { message: SESSION_LIMIT_MESSAGE, type: "freepi_proxy_error", code: "session_limit" } },
        { status: 409 },
      ),
      jwt: null,
    };
  }
  return {
    response: Response.json(
      { error: { message: "all configured accounts are gated; add another account to the pool or retry later", code: "pool_exhausted" } },
      { status: 429 },
    ),
    jwt: null,
  };
}
