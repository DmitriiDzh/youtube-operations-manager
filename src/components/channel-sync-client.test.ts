import assert from "node:assert/strict";
import test from "node:test";
import { postChannelSync } from "./channel-sync-client";

// Requirements: the sync endpoint refuses a second concurrent sync with 409 (`operation_already_running`
// + the running operation's id). That is not a failure for the operator. A user-pressed sync waits for
// the running one and then runs once more (so the data is fresh and the result has the channel); a
// background auto-resync just waits and reports that another sync did the work. Any OTHER failure is
// returned unchanged so existing error handling keeps working.

type Reply = { status: number; body: unknown };
function harness(replies: Reply[], waitResult: "finished" | "gone" | "timeout" = "finished") {
  const posts: unknown[] = [];
  const waited: string[] = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    posts.push(JSON.parse(init.body));
    const next = replies[Math.min(i++, replies.length - 1)];
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  }) as unknown as typeof fetch;
  const wait = async (id: string) => {
    waited.push(id);
    return waitResult;
  };
  return { fetchImpl, wait, posts, waited };
}

const conflict = { status: 409, body: { error: "operation_already_running", message: "m", details: { operationId: "op-7" } } };
const ok = { status: 200, body: { videoCount: 3, channel: { title: "T" } } };

test("a normal sync is returned as is, nothing is waited for", async () => {
  const h = harness([ok]);
  const out = await postChannelSync("UC1", { onConflict: "retry", fetchImpl: h.fetchImpl, wait: h.wait });
  assert.equal(out.res.ok, true);
  assert.deepEqual(out.data, ok.body);
  assert.equal(out.waitedForOther, false);
  assert.deepEqual(h.waited, []);
  assert.deepEqual(h.posts, [{ channelId: "UC1" }]);
});

test("no channelId sends an empty body (the implicit 'my channel' sync)", async () => {
  const h = harness([ok]);
  await postChannelSync(undefined, { onConflict: "retry", fetchImpl: h.fetchImpl, wait: h.wait });
  assert.deepEqual(h.posts, [{}]);
});

test("retry: a 409 waits for the running operation, then syncs once more and returns THAT result", async () => {
  const h = harness([conflict, ok]);
  const out = await postChannelSync("UC1", { onConflict: "retry", fetchImpl: h.fetchImpl, wait: h.wait });
  assert.deepEqual(h.waited, ["op-7"]);
  assert.equal(h.posts.length, 2);
  assert.equal(out.res.ok, true);
  assert.deepEqual(out.data, ok.body);
  assert.equal(out.waitedForOther, true);
});

test("retry: a second 409 is returned as the failure it is (no endless loop)", async () => {
  const h = harness([conflict, conflict]);
  const out = await postChannelSync("UC1", { onConflict: "retry", fetchImpl: h.fetchImpl, wait: h.wait });
  assert.equal(h.posts.length, 2);
  assert.equal(out.res.ok, false);
  assert.equal(out.res.status, 409);
});

test("skip: a 409 waits and does NOT sync again; the result says another sync did the work", async () => {
  const h = harness([conflict]);
  const out = await postChannelSync("UC1", { onConflict: "skip", fetchImpl: h.fetchImpl, wait: h.wait });
  assert.deepEqual(h.waited, ["op-7"]);
  assert.equal(h.posts.length, 1);
  assert.equal(out.res.ok, true);
  assert.equal(out.waitedForOther, true);
  assert.equal(out.data, null);
});

test("a 409 that is not operation_already_running is not swallowed", async () => {
  const other = { status: 409, body: { error: "WRITE_CHANNEL_MISMATCH", message: "wrong channel" } };
  const h = harness([other]);
  const out = await postChannelSync("UC1", { onConflict: "retry", fetchImpl: h.fetchImpl, wait: h.wait });
  assert.deepEqual(h.waited, []);
  assert.equal(out.res.status, 409);
  assert.equal(out.res.ok, false);
});

test("other failures (e.g. 500) are returned unchanged", async () => {
  const h = harness([{ status: 500, body: { error: "internal_error", message: "boom" } }]);
  const out = await postChannelSync("UC1", { onConflict: "skip", fetchImpl: h.fetchImpl, wait: h.wait });
  assert.equal(out.res.ok, false);
  assert.equal((out.data as { message: string }).message, "boom");
});

test("a wait that times out is reported as a failure, not as success", async () => {
  const h = harness([conflict], "timeout");
  const out = await postChannelSync("UC1", { onConflict: "skip", fetchImpl: h.fetchImpl, wait: h.wait });
  assert.equal(out.res.ok, false);
  assert.match((out.data as { message: string }).message, /still running|timed out|did not finish/i);
});
