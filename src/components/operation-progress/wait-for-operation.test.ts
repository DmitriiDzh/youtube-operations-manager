import assert from "node:assert/strict";
import test from "node:test";
import { waitForOperation } from "./wait-for-operation";

// Requirement (independent review 2026-10-03): when a start request is refused with 409 because the same
// operation is already running, the client must wait for THAT run quietly and carry on -- not show an
// error. Waiting ends when the run is over (any final status), when it has disappeared (404: expired or
// the server restarted), or when a time limit is hit; a transient poll failure must not end the wait.

function scripted(responses: Array<{ status: number; body?: unknown } | Error>) {
  let i = 0;
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const next = responses[Math.min(i++, responses.length - 1)];
    if (next instanceof Error) throw next;
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body ?? {} };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const running = { status: 200, body: { status: "running" } };
const done = (status: string) => ({ status: 200, body: { status } });
const noSleep = async () => undefined;

test("returns finished as soon as the operation reaches any final status", async () => {
  for (const finalStatus of ["success", "failed", "cancelled"]) {
    const { fetchImpl } = scripted([running, running, done(finalStatus)]);
    assert.equal(await waitForOperation("op-1", { fetchImpl, sleep: noSleep }), "finished", finalStatus);
  }
});

test("keeps waiting while the status is running or cancelling", async () => {
  const { fetchImpl, calls } = scripted([running, { status: 200, body: { status: "cancelling" } }, done("cancelled")]);
  assert.equal(await waitForOperation("op-1", { fetchImpl, sleep: noSleep }), "finished");
  assert.equal(calls.length, 3);
  assert.match(calls[0], /\/api\/operations\/op-1$/);
});

test("a 404 means the operation is gone (expired or the server restarted)", async () => {
  const { fetchImpl } = scripted([running, { status: 404 }]);
  assert.equal(await waitForOperation("op-1", { fetchImpl, sleep: noSleep }), "gone");
});

test("a failed poll (network error or 500) does not end the wait", async () => {
  const { fetchImpl, calls } = scripted([new Error("network"), { status: 500 }, done("success")]);
  assert.equal(await waitForOperation("op-1", { fetchImpl, sleep: noSleep }), "finished");
  assert.equal(calls.length, 3);
});

test("gives up with timeout once the time limit is exceeded", async () => {
  let t = 0;
  const { fetchImpl } = scripted([running]);
  const result = await waitForOperation("op-1", {
    fetchImpl,
    intervalMs: 1_000,
    timeoutMs: 5_000,
    now: () => t,
    sleep: async (ms) => void (t += ms),
  });
  assert.equal(result, "timeout");
});

test("the operation id is URL-encoded", async () => {
  const { fetchImpl, calls } = scripted([done("success")]);
  await waitForOperation("a/b c", { fetchImpl, sleep: noSleep });
  assert.match(calls[0], /\/api\/operations\/a%2Fb%20c$/);
});
