// The forced-update gate: upstream answers 426 upgrade_required when
// x-client-version is below its minimum. The proxy must learn the required
// version, persist it, and replay the call instead of surfacing the error.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";

process.env.HOME = await mkdtemp(join(tmpdir(), "freepi-upgrade-test-"));
// Explicit data dir: os.homedir() is cached at process start on some runtimes.
process.env.FREEPI_DATA_DIR = join(process.env.HOME, ".freepi-proxy");

interface Seen { path: string; version: string }
type Reply = { status: number; body: string };

const seen: Seen[] = [];
let reply: (n: number, rec: Seen) => Reply = () => ({ status: 200, body: "{}" });
let completionCalls = 0;

const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const rec = { path: req.url ?? "", version: String(req.headers["x-client-version"] ?? "") };
    seen.push(rec);
    const n = rec.path === "/v1/chat/completions" ? completionCalls++ : seen.length;
    const r = reply(n, rec);
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.body);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { Upstream } = await import("../src/upstream.ts");
// Import config after Upstream so the path is the one the module resolved.
const { CLIENT_VERSION_PATH } = await import("../src/config.ts");
const VERSION_FILE = CLIENT_VERSION_PATH;
// Guard: never write version state into a user's real data dir.
assert.ok(VERSION_FILE.startsWith(tmpdir()), `test data dir escaped to ${VERSION_FILE}`);

const catalogBody = JSON.stringify({
  min: "0.6.21",
  latest: "0.6.22",
  model: "deepseek-v4-flash",
  models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash · Free Unlimited", free: true }],
});

const gateBody = JSON.stringify({
  error: {
    status: 426,
    message: "your free-pi-cli is below the required minimum (0.6.21); update with: npx free-pi-cli@latest",
    type: "free_pi_error",
    param: "upgrade_required",
  },
});

test.after(() => server.close());

async function seed(version: string): Promise<void> {
  await mkdir(dirname(VERSION_FILE), { recursive: true });
  await writeFile(VERSION_FILE, version);
}

test("a 426 gate replays the completion with the required client version", async () => {
  seen.length = 0;
  completionCalls = 0;
  reply = (n, rec) => {
    if (rec.path === "/client-version") return { status: 500, body: "catalog down" };
    return n === 0 ? { status: 426, body: gateBody } : { status: 200, body: '{"ok":true}' };
  };

  await seed("0.6.19");
  const up = new Upstream(url);
  const res = await up.completions("jwt", "{}", AbortSignal.timeout(5_000));
  assert.equal(res.status, 200);

  const attempts = seen.filter((s) => s.path === "/v1/chat/completions");
  assert.equal(attempts.length, 2, "exactly one replay");
  assert.equal(attempts[0]!.version, "0.6.19");
  assert.ok(attempts[1]!.version >= "0.6.21", `replay sent ${attempts[1]!.version}`);

  const saved = (await readFile(VERSION_FILE, "utf8")).trim();
  assert.ok(saved >= "0.6.21", `persisted ${saved}`);
});

test("the learned version survives a restart and never regresses", async () => {
  seen.length = 0;
  completionCalls = 0;
  reply = () => ({ status: 200, body: catalogBody });

  await seed("7.7.7");
  const up = new Upstream(url);
  assert.equal(up.version, "7.7.7", "persisted version is restored");

  await up.refreshCatalog();
  assert.equal(up.version, "7.7.7", "a newer catalog version never downgrades us");

  await up.completions("jwt", "{}", AbortSignal.timeout(5_000));
  const sent = seen.find((s) => s.path === "/v1/chat/completions");
  assert.equal(sent?.version, "7.7.7");
});

test("an error body alone teaches the required version", async () => {
  await seed("0.1.0");
  const up = new Upstream(url);
  up.noteRequiredVersion("below the required minimum (0.9.9)");
  assert.equal(up.version, "0.9.9");
});
