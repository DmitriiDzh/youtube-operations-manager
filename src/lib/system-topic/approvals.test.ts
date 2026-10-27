import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { canonicalJson, requestHash } from "./approvals";
import { DIR, fakeAction, harness, inbound, requestFile, T0 } from "./test-fakes";

// BL-228 (SYSTEM_TOPIC_PLAN.md §5 as amended, §7 AC-SYS-08..12; ADR 0053 Amendment 1; owner msg 3607): a paid call runs only after
// the owner's `approve <id>` in the topic AND the Confirm in the Web UI, at most once, within 2 h of createdAt, unchanged since it
// was posted, within the cap. Expected values are worked out by hand from the plan (the hashes with `shasum -a 256`). Fakes only.

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
/** sha256('{"action":"factory_media_start_session","args":{"channelId":"UCa2amtpeOmgP-HkiLKPm1gg","maxMinutes":60,"maxUsd":2,"releaseWhenDone":true}}'), first 8 hex. */
const POSTED_HASH = "ea625a79";

async function posted(h: ReturnType<typeof harness>, id = "r1", overrides: Record<string, unknown> = {}) {
  h.files.files.set(`${id}.json`, requestFile(id, overrides));
  await h.approvals.scan();
}
const say = async (h: ReturnType<typeof harness>, updateId: number, text: string) => (await h.topic.handleInbound(inbound(updateId, text))).replies[0];

test("the request hash: canonical JSON of { action, args } (keys sorted, no whitespace), first 8 hex of SHA-256", () => {
  assert.equal(canonicalJson({ args: { b: 1, a: 2 }, action: "x" }), '{"action":"x","args":{"a":2,"b":1}}');
  // printf '%s' '{"action":"x","args":{"a":2,"b":1}}' | shasum -a 256 -> 99b37b0f...
  assert.equal(requestHash("x", { b: 1, a: 2 }), "99b37b0f");
  assert.equal(requestHash("factory_media_start_session", { releaseWhenDone: true, maxUsd: 2, maxMinutes: 60, channelId: "UCa2amtpeOmgP-HkiLKPm1gg" }), POSTED_HASH);
});

test("a new request is posted once, with the Manager's own estimate and the hash; the next scan posts nothing", async () => {
  const h = harness({ action: fakeAction({ estimateUsd: 1.5 }) });
  await posted(h);
  await h.approvals.scan();
  assert.equal(h.store.outbox.length, 1);
  const text = h.store.outbox[0].text;
  assert.match(text, /^Paid-call request r1 from operator\n/);
  assert.match(text, /factory_media_start_session 60 min/);
  assert.match(text, /Estimate \(YT Manager\): \$1\.50 \(the request says \$1\.20\)/);
  assert.match(text, new RegExp(`Hash: ${POSTED_HASH}`));
  assert.equal(h.requests.rows.get("r1")!.state, "posted");
  assert.equal(h.action.runs.length, 0);
});

test("the full path: approve in the topic, then Confirm runs the call once as owner (System), result file done", async () => {
  const h = harness();
  await posted(h);
  assert.equal(await say(h, 1, "approve r1"), "approved -- confirm in YT Manager (Settings → AI agent → System (Telegram))");
  assert.equal(h.requests.rows.get("r1")!.state, "approved_in_topic");
  assert.equal(h.action.runs.length, 0, "the topic approve alone runs nothing");
  const view = await h.approvals.confirm("r1");
  assert.equal(view.state, "done");
  assert.deepEqual(h.action.runs, [{ args: { channelId: "UCa2amtpeOmgP-HkiLKPm1gg", maxMinutes: 60, maxUsd: 2, releaseWhenDone: true }, actor: "owner (System)" }]);
  const result = h.files.results.get("r1")!;
  assert.deepEqual({ ...result, at: "-" }, { format: 1, id: "r1", status: "done", at: "-", result: { sessionId: "s-1" } });
  assert.match(h.store.outbox.at(-1)!.text, /^Request r1: done\.$/);
});

test("a Web confirm without the topic approve is impossible: refused, the tool is not called", async () => {
  const h = harness();
  await posted(h);
  await assert.rejects(h.approvals.confirm("r1"), (e: unknown) => isDomainError(e) && e.code === "system_topic_request_state");
  assert.equal(h.action.runs.length, 0);
  assert.equal(h.requests.rows.get("r1")!.state, "posted");
  await assert.rejects(h.approvals.confirm("nope"), (e: unknown) => isDomainError(e) && e.code === "system_topic_request_not_found");
});

test("AC-SYS-09: approve twice, confirm twice: the tool is called exactly once; the second confirm and a later approve say used", async () => {
  const h = harness();
  await posted(h);
  await say(h, 1, "approve r1");
  assert.match(await say(h, 2, "approve r1"), /is approved -- confirm it in YT Manager/);
  await h.approvals.confirm("r1");
  await assert.rejects(h.approvals.confirm("r1"), (e: unknown) => isDomainError(e) && e.code === "system_topic_request_state" && /^used:/.test(e.message));
  assert.match(await say(h, 3, "approve r1"), /^used: request r1 was already confirmed$/);
  assert.equal(h.action.runs.length, 1);
});

test("AC-SYS-08: a request created 2 h 1 min ago is expired at its first scan; the tool is never called", async () => {
  const h = harness();
  h.clock.now = T0 + 2 * HOUR + MIN;
  await posted(h);
  assert.equal(h.requests.rows.get("r1")!.state, "expired");
  assert.equal(h.files.results.get("r1")!.status, "expired");
  assert.match(await say(h, 1, "approve r1"), /expired/);
  assert.equal(h.action.runs.length, 0);
});

test("AC-SYS-08: approved in time, confirmed at 2 h 1 min: expired, the tool is not called; at exactly 2 h it still runs", async () => {
  const late = harness();
  await posted(late);
  await say(late, 1, "approve r1");
  late.clock.now = T0 + 2 * HOUR + MIN;
  assert.equal((await late.approvals.confirm("r1")).state, "expired");
  assert.equal(late.action.runs.length, 0);
  assert.equal(late.files.results.get("r1")!.status, "expired");

  const edge = harness();
  await posted(edge);
  await say(edge, 1, "approve r1");
  edge.clock.now = T0 + 2 * HOUR;
  assert.equal((await edge.approvals.confirm("r1")).state, "done");
  assert.equal(edge.action.runs.length, 1);
});

test("a createdAt in the future is expired", async () => {
  const h = harness();
  await posted(h, "r1", { createdAt: new Date(T0 + HOUR).toISOString() });
  assert.equal(h.requests.rows.get("r1")!.state, "expired");
});

test("the scan expires a posted or approved request once it is past 2 h", async () => {
  const h = harness();
  await posted(h, "r1");
  await posted(h, "r2");
  await say(h, 1, "approve r2");
  h.clock.now = T0 + 2 * HOUR + MIN;
  await h.approvals.scan();
  assert.equal(h.requests.rows.get("r1")!.state, "expired");
  assert.equal(h.requests.rows.get("r2")!.state, "expired");
  assert.equal(h.action.runs.length, 0);
});

test("AC-SYS-10: the file's args.maxMinutes changed after posting: Confirm refuses on the hash, the tool is not called", async () => {
  const h = harness();
  await posted(h);
  await say(h, 1, "approve r1");
  h.files.files.set("r1.json", requestFile("r1", { args: { channelId: "UCa2amtpeOmgP-HkiLKPm1gg", maxMinutes: 600, maxUsd: 2, releaseWhenDone: true } }));
  const view = await h.approvals.confirm("r1");
  assert.equal(view.state, "refused");
  assert.match(view.refusal ?? "", new RegExp(`changed after it was posted \\(hash [0-9a-f]{8}, posted ${POSTED_HASH}\\)`));
  assert.equal(h.action.runs.length, 0);
  assert.equal(h.files.results.get("r1")!.status, "refused");
});

test("a request file removed before Confirm is refused, not run", async () => {
  const h = harness();
  await posted(h);
  await say(h, 1, "approve r1");
  h.files.files.delete("r1.json");
  assert.equal((await h.approvals.confirm("r1")).state, "refused");
  assert.equal(h.action.runs.length, 0);
});

test("AC-SYS-11: an estimate of $2.01 is refused at the scan and cannot be approved; $2.00 is posted", async () => {
  const over = harness({ action: fakeAction({ estimateUsd: 2.01 }) });
  await posted(over);
  assert.equal(over.requests.rows.get("r1")!.state, "refused");
  assert.match(over.requests.rows.get("r1")!.refusal ?? "", /\$2\.01 is over the \$2\.00 cap/);
  assert.match(await say(over, 1, "approve r1"), /was refused/);
  assert.equal(over.action.runs.length, 0);

  const at = harness({ action: fakeAction({ estimateUsd: 2 }) });
  await posted(at);
  assert.equal(at.requests.rows.get("r1")!.state, "posted");
});

test("a limit refusal of the action (the existing day/month limits) refuses the request, also at Confirm", async () => {
  const h = harness();
  await posted(h);
  await say(h, 1, "approve r1");
  // The limits changed after posting: the Confirm checks them again.
  const limited = fakeAction({ refusal: "the factory's day would reach $5 (limit $4)" });
  h.action.action.check = limited.action.check;
  const view = await h.approvals.confirm("r1");
  assert.equal(view.state, "refused");
  assert.match(view.refusal ?? "", /limit \$4/);
  assert.equal(h.action.runs.length, 0);
});

test("AC-SYS-12: an action outside the allowlist is posted as refused and cannot be approved", async () => {
  const h = harness();
  await posted(h, "r1", { action: "factory_media_delete_model", args: { key: "x" } });
  const row = h.requests.rows.get("r1")!;
  assert.equal(row.state, "refused");
  assert.match(row.refusal ?? "", /action factory_media_delete_model is not allowed here/);
  assert.match(h.store.outbox[0].text, /^Request r1 \(factory_media_delete_model from operator\): refused --/);
  assert.match(await say(h, 1, "approve r1"), /was refused/);
  await assert.rejects(h.approvals.confirm("r1"), (e: unknown) => isDomainError(e) && e.code === "system_topic_request_state");
  assert.equal(h.files.results.get("r1")!.status, "refused");
});

test("args that fail the tool's schema are refused at the scan", async () => {
  const h = harness();
  await posted(h, "r1", { args: { channelId: "UC" } });
  assert.match(h.requests.rows.get("r1")!.refusal ?? "", /fail the tool's schema: maxMinutes is required/);
});

test("a file that is not JSON (still being written) is skipped and read again; a wrong shape or id is refused once", async () => {
  const h = harness();
  h.files.files.set("r1.json", "{\"format\": 1, \"id\": ");
  await h.approvals.scan();
  assert.equal(h.requests.rows.size, 0);
  h.files.files.set("r1.json", requestFile("r1"));
  await h.approvals.scan();
  assert.equal(h.requests.rows.get("r1")!.state, "posted");

  h.files.files.set("r2.json", JSON.stringify({ format: 2 }));
  h.files.files.set("r3.json", requestFile("other-id"));
  h.files.files.set(".hidden.json", requestFile(".hidden"));
  h.files.files.set("notes.txt", "x");
  await h.approvals.scan();
  assert.equal(h.requests.rows.get("r2")!.state, "refused");
  assert.match(h.requests.rows.get("r3")!.refusal ?? "", /its id is not its file name/);
  assert.equal(h.requests.rows.has(".hidden"), false);
});

test("deny in the topic or on the Web: denied, a result file, never run", async () => {
  const h = harness();
  await posted(h, "r1");
  await posted(h, "r2");
  await say(h, 1, "approve r2");
  assert.equal(await say(h, 2, "deny r1"), "denied");
  assert.equal((await h.approvals.deny("r2")).state, "denied");
  assert.equal(h.files.results.get("r1")!.status, "denied");
  assert.equal(h.files.results.get("r2")!.status, "denied");
  await assert.rejects(h.approvals.confirm("r2"), (e: unknown) => isDomainError(e) && e.code === "system_topic_request_state");
  assert.match(await say(h, 3, "approve r1"), /was denied/);
  assert.equal(h.action.runs.length, 0);
});

test("a call that fails is recorded failed (still used), with its error in the result file", async () => {
  const h = harness({ action: fakeAction({ fail: "held for the owner in Servers: device limit" }) });
  await posted(h);
  await say(h, 1, "approve r1");
  assert.equal((await h.approvals.confirm("r1")).state, "failed");
  assert.equal(h.files.results.get("r1")!.status, "failed");
  assert.equal(h.files.results.get("r1")!.error, "held for the owner in Servers: device limit");
  await assert.rejects(h.approvals.confirm("r1"), (e: unknown) => isDomainError(e) && e.code === "system_topic_request_state");
  assert.equal(h.action.runs.length, 1);
});

test("Confirm while the feature is off is refused (system_topic_disabled); the scan does nothing while off", async () => {
  const h = harness();
  await posted(h);
  await say(h, 1, "approve r1");
  h.store.state.enabled = false;
  await assert.rejects(h.approvals.confirm("r1"), (e: unknown) => isDomainError(e) && e.code === "system_topic_disabled");
  h.files.files.set("r2.json", requestFile("r2"));
  assert.deepEqual(await h.approvals.scan(), { scanned: false });
  assert.equal(h.requests.rows.has("r2"), false);
  assert.equal(h.action.runs.length, 0);
});

test("a missing requests folder is a scan error, not a crash", async () => {
  const h = harness();
  h.files.list = async () => null;
  await assert.rejects(h.approvals.scan(), new RegExp(`the requests folder ${DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} does not exist`));
});

test("at boot, a request left `confirmed` (the process died during the call) becomes failed with a result file; it is never run", async () => {
  const h = harness();
  await posted(h);
  await say(h, 1, "approve r1");
  await h.requests.transition("r1", ["approved_in_topic"], { state: "confirmed", confirmedAt: h.clock.now });
  assert.equal(await h.approvals.sweepInterrupted(), 1);
  assert.equal(h.requests.rows.get("r1")!.state, "failed");
  assert.equal(h.files.results.get("r1")!.status, "failed");
  assert.match(String(h.files.results.get("r1")!.error), /interrupted by a server restart/);
  assert.match(h.store.outbox.at(-1)!.text, /^Request r1: failed -- interrupted by a server restart/);
  assert.equal(h.action.runs.length, 0);
  assert.equal(await h.approvals.sweepInterrupted(), 0);
});

// -- Independent review of BL-228 -------------------------------------------------------------------------------------------------

test("review 1: Confirm compares the whole { action, args }, not the 8-hex hash -- a colliding display hash is still refused", async () => {
  // Every text hashes the same: the display hash and the fingerprint can no longer tell two requests apart.
  const h = harness({ hash: () => "0".repeat(64) });
  await posted(h);
  await say(h, 1, "approve r1");
  h.files.files.set("r1.json", requestFile("r1", { args: { channelId: "UCa2amtpeOmgP-HkiLKPm1gg", maxMinutes: 61, maxUsd: 2, releaseWhenDone: true } }));
  const view = await h.approvals.confirm("r1");
  assert.equal(view.state, "refused");
  assert.match(view.refusal ?? "", /changed after it was posted/);
  assert.equal(h.action.runs.length, 0);
});

test("review 1: the same request written again with other key order and spacing still runs, with the STORED args", async () => {
  const h = harness();
  await posted(h);
  await say(h, 1, "approve r1");
  h.files.files.set(
    "r1.json",
    `{ "reason": "render V52", "args": { "releaseWhenDone": true, "maxUsd": 2, "maxMinutes": 60, "channelId": "UCa2amtpeOmgP-HkiLKPm1gg" },
       "action": "factory_media_start_session", "requestedBy": "operator", "createdAt": "${new Date(T0).toISOString()}", "id": "r1", "format": 1 }`
  );
  assert.equal((await h.approvals.confirm("r1")).state, "done");
  assert.deepEqual(h.action.runs.map((r) => r.args), [{ channelId: "UCa2amtpeOmgP-HkiLKPm1gg", maxMinutes: 60, maxUsd: 2, releaseWhenDone: true }]);
});

test("review 6: an input file that changed after posting is refused at Confirm; one that cannot be read is refused at the scan", async () => {
  const inputs = { "frames/a.png": "a".repeat(64) };
  const action = fakeAction();
  action.action.inputHashes = async () => ({ ...inputs });
  const h = harness({ action });
  await posted(h);
  assert.equal(h.requests.rows.get("r1")!.state, "posted");
  assert.match(h.requests.rows.get("r1")!.fingerprint ?? "", /^[0-9a-f]{64}$/);
  await say(h, 1, "approve r1");
  inputs["frames/a.png"] = "b".repeat(64);
  const view = await h.approvals.confirm("r1");
  assert.equal(view.state, "refused");
  assert.equal(view.refusal, "an input file changed after the request was posted");
  assert.equal(action.runs.length, 0);

  const unreadable = fakeAction();
  unreadable.action.inputHashes = async () => {
    throw new Error("frames/a.png is missing");
  };
  const u = harness({ action: unreadable });
  await posted(u);
  assert.equal(u.requests.rows.get("r1")!.state, "refused");
  assert.equal(u.requests.rows.get("r1")!.refusal, "an input file cannot be read: frames/a.png is missing");
});

function slowAction() {
  const action = fakeAction();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const run = action.action.run;
  action.action.run = async (args, actor) => {
    await gate;
    return run(args, actor);
  };
  return { action, release: () => release() };
}

test("review 2: a sweep while a Confirm of this process is running leaves it alone; it ends done, no failed result file", async () => {
  const slow = slowAction();
  // Even a process start after the confirm time (a clock step) does not let the sweep take an in-flight confirm.
  const h = harness({ action: slow.action, processStartedAt: T0 + 10 * HOUR });
  await posted(h);
  await say(h, 1, "approve r1");
  const confirming = h.approvals.confirm("r1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.requests.rows.get("r1")!.state, "confirmed");
  assert.equal(await h.approvals.sweepInterrupted(), 0);
  assert.equal(h.files.results.has("r1"), false);
  slow.release();
  assert.equal((await confirming).state, "done");
  assert.equal(h.files.results.get("r1")!.status, "done");
  assert.equal(slow.action.runs.length, 1);
});

test("review 2: a row confirmed at or after this process started is not swept; review 3: nothing is swept off the Mac service", async () => {
  const h = harness({ processStartedAt: T0 });
  await posted(h);
  await say(h, 1, "approve r1");
  await h.requests.transition("r1", ["approved_in_topic"], { state: "confirmed", confirmedAt: T0 + MIN });
  assert.equal(await h.approvals.sweepInterrupted(), 0);
  assert.equal(h.requests.rows.get("r1")!.state, "confirmed");

  const off = harness({ service: false });
  await off.requests.insert({ ...h.requests.rows.get("r1")!, confirmedAt: T0 - HOUR });
  assert.equal(await off.approvals.sweepInterrupted(), 0);
  assert.equal(off.requests.rows.get("r1")!.state, "confirmed");
});

test("review 7: two Confirms at once with a slow call: exactly one tool call; the other is refused as used", async () => {
  const slow = slowAction();
  const h = harness({ action: slow.action });
  await posted(h);
  await say(h, 1, "approve r1");
  const both = Promise.allSettled([h.approvals.confirm("r1"), h.approvals.confirm("r1")]);
  await new Promise((resolve) => setImmediate(resolve));
  slow.release();
  const [a, b] = await both;
  const outcomes = [a, b].map((r) => r.status);
  assert.deepEqual(outcomes.sort(), ["fulfilled", "rejected"]);
  const rejected = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(isDomainError(rejected.reason) && rejected.reason.code === "system_topic_request_state");
  assert.equal(slow.action.runs.length, 1);
  assert.equal(h.requests.rows.get("r1")!.state, "done");
});

test("FO-RESP-0045: a free action ($0 estimate, $0 cap) goes through the same two steps and runs once", async () => {
  const h = harness({ action: fakeAction({ estimateUsd: 0, capUsd: 0 }) });
  await posted(h);
  assert.equal(h.requests.rows.get("r1")!.state, "posted");
  assert.match(h.store.outbox[0].text, /Estimate \(YT Manager\): \$0\.00/);
  await assert.rejects(h.approvals.confirm("r1"), (e: unknown) => isDomainError(e) && e.code === "system_topic_request_state");
  await say(h, 1, "approve r1");
  assert.equal((await h.approvals.confirm("r1")).state, "done");
  assert.equal(h.action.runs.length, 1);
});
