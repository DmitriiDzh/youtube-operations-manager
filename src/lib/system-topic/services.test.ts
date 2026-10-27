import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { createSystemTopic } from "./services";
import { CHAT, CONFIG, CONFIG_PATH, harness, message, OWNER, STATUS_ARGV, TOKEN, TOPIC, TROPICO_ROOT } from "./test-fakes";

// BL-228 stage 1 (docs/roadmap/plans/SYSTEM_TOPIC_PLAN.md §2, §3, §7; ADR 0053). Expected values are the plan's, worked out by hand:
// only the owner in the one topic is heard (AC-SYS-01/02), `status <channel>` runs the factory's argv once with `channelArg <name>` and
// posts at most 3500 characters + "…" (AC-SYS-03), the switch off means no Telegram call (AC-SYS-13), the token is never in a log, a
// stored error or a thrown error (AC-SYS-14). Fakes only: no network, no database, no child process.

test("AC-SYS-01: `status` from another user in the topic gets no reply, no audit row, and the dropped counter rises", async () => {
  const h = harness();
  h.batches.push([message(100, "status", { from: 999 })]);
  await createSystemTopic(h.deps).tick();
  assert.deepEqual(h.sent, []);
  assert.equal(h.store.rows.size, 0);
  assert.equal(h.runs.length, 0);
  assert.equal(h.store.state.droppedCount, 1);
  assert.equal(h.store.state.pollOffset, 101);
});

test("AC-SYS-02: `status` from the owner in another topic, outside any topic or in another chat is ignored", async () => {
  const h = harness();
  h.batches.push([message(200, "status", { thread: 7 }), message(201, "status", { thread: null }), message(202, "status", { chat: -100999 })]);
  await createSystemTopic(h.deps).tick();
  assert.deepEqual(h.sent, []);
  assert.equal(h.store.rows.size, 0);
  assert.equal(h.store.state.droppedCount, 3);
  assert.equal(h.store.state.pollOffset, 203);
});

test("AC-SYS-03: `status tropico` runs the configured argv once with --channel tropico in the channel root and posts its output", async () => {
  const h = harness({ result: { output: "tropico: 2 jobs running\n", exitCode: 0, timedOut: false, error: null } });
  h.batches.push([message(300, "status tropico")]);
  await createSystemTopic(h.deps).tick();
  assert.deepEqual(h.runs, [{ argv: [...STATUS_ARGV, "--channel", "tropico"], cwd: TROPICO_ROOT, timeoutMs: 60_000 }]);
  assert.deepEqual(h.sent, [{ chatId: String(CHAT), threadId: TOPIC, text: "tropico: 2 jobs running\n" }]);
  const row = h.store.rows.get(300)!;
  assert.equal(row.status, "done");
  assert.equal(row.command, "status");
  assert.equal(row.fromUserId, String(OWNER));
  assert.equal(row.text, "status tropico");
});

test("AC-SYS-03: 5000 characters of output are posted as the first 3500 + …", async () => {
  const output = "a".repeat(3500) + "b".repeat(1500);
  const h = harness({ result: { output, exitCode: 0, timedOut: false, error: null } });
  h.batches.push([message(301, "status")]);
  await createSystemTopic(h.deps).tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, `${"a".repeat(3500)}…`);
  assert.equal(Array.from(h.sent[0].text).length, 3501);
});

test("`status` without a channel runs the argv unchanged, with no channel root", async () => {
  const h = harness();
  h.batches.push([message(302, "STATUS")]);
  await createSystemTopic(h.deps).tick();
  assert.deepEqual(h.runs, [{ argv: STATUS_ARGV, cwd: undefined, timeoutMs: 60_000 }]);
});

test("`status` exiting non-zero or timing out is posted as failed, with the reason after the output", async () => {
  const failed = harness({ result: { output: "boom", exitCode: 2, timedOut: false, error: null } });
  failed.batches.push([message(303, "status")]);
  await createSystemTopic(failed.deps).tick();
  assert.equal(failed.sent[0].text, "boom\n(exit code 2)");
  assert.equal(failed.store.rows.get(303)!.status, "failed");

  const slow = harness({ result: { output: "", exitCode: null, timedOut: true, error: null } });
  slow.batches.push([message(304, "status")]);
  await createSystemTopic(slow.deps).tick();
  assert.equal(slow.sent[0].text, "(no output)\n(stopped after 60 s)");
});

test("`status <unknown channel>` is refused and nothing runs", async () => {
  const h = harness();
  h.batches.push([message(310, "status japan")]);
  await createSystemTopic(h.deps).tick();
  assert.equal(h.runs.length, 0);
  assert.equal(h.sent[0].text, 'refused: unknown channel "japan" (known: tropico)');
  assert.equal(h.store.rows.get(310)!.status, "refused");
});

test("`status tropico` with a config root that is not the channel's workspace path is refused (channel_root_mismatch), nothing runs", async () => {
  for (const workspace of ["/Volumes/Other/01 Tropico Jazz", null]) {
    const h = harness({ workspace });
    h.batches.push([message(311, "status tropico")]);
    await createSystemTopic(h.deps).tick();
    assert.equal(h.runs.length, 0, String(workspace));
    assert.match(h.sent[0].text, /^refused \(channel_root_mismatch\)/);
  }
});

test("the same root written with a trailing slash still matches", async () => {
  const h = harness({ workspace: `${TROPICO_ROOT}/` });
  h.batches.push([message(312, "status tropico")]);
  await createSystemTopic(h.deps).tick();
  assert.equal(h.runs.length, 1);
});

test("a missing, broken or wrong-format config is a refusal reply, never a crash; nothing runs", async () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /^refused: no commands config at /],
    ["{not json", /not valid JSON/],
    [{ ...CONFIG, format: 2 }, /does not match format 1 \(format:/],
    [{ ...CONFIG, status: { argv: [] } }, /does not match format 1 \(status\.argv:/],
  ];
  for (const [config, expected] of cases) {
    const h = harness({ config });
    h.batches.push([message(320, "status")]);
    await createSystemTopic(h.deps).tick();
    assert.equal(h.runs.length, 0);
    assert.match(h.sent[0].text, expected);
  }
  const none = harness({ state: { commandsPath: null } });
  none.batches.push([message(321, "status")]);
  await createSystemTopic(none.deps).tick();
  assert.equal(none.sent[0].text, "refused: no commands.json path is set in the Manager's Settings");
});

test("a relative path in status.argv: refused without a channel root, and refused when it leaves the root", async () => {
  const relative = harness({ config: { ...CONFIG, status: { argv: ["python3", "90 Scripts/status.py"], channelArg: "--channel" } } });
  relative.batches.push([message(330, "status")]);
  await createSystemTopic(relative.deps).tick();
  assert.equal(relative.runs.length, 0);
  assert.match(relative.sent[0].text, /needs a channel root/);

  const escaping = harness({ config: { ...CONFIG, status: { argv: ["python3", "../00 YT Operator/x.py"], channelArg: "--channel" } } });
  escaping.batches.push([message(331, "status tropico")]);
  await createSystemTopic(escaping.deps).tick();
  assert.equal(escaping.runs.length, 0);
  assert.match(escaping.sent[0].text, /leaves the channel root/);

  const insideRoot = harness({ config: { ...CONFIG, status: { argv: ["python3", "06 Workflows/status.py"], channelArg: "--channel" } } });
  insideRoot.batches.push([message(332, "status tropico")]);
  await createSystemTopic(insideRoot.deps).tick();
  assert.deepEqual(insideRoot.runs[0].argv, ["python3", "06 Workflows/status.py", "--channel", "tropico"]);
});

test("help, unknown text, wrong arguments and the later stages' commands get their one-line replies; nothing runs", async () => {
  const h = harness();
  h.batches.push([message(400, "/help@SystemBot"), message(401, "please deploy"), message(402, "go"), message(403, "stop tropico 2026-10-28T10"), message(404, "approve r1"), message(405, "deny r1"), message(406, "go tropico")]);
  await createSystemTopic(h.deps).tick();
  assert.equal(h.runs.length, 0);
  const texts = h.sent.map((s) => s.text);
  assert.match(texts[0], /^Commands:\n/);
  assert.deepEqual(texts.slice(1), ["unknown command, see help", "usage: go <channel>", "stop is not available yet", "approve is not available yet", "deny is not available yet", "go is not available yet"]);
  assert.deepEqual([...h.store.rows.values()].map((r) => r.status), ["done", "unknown", "usage", "not_available", "not_available", "not_available", "not_available"]);
});

test("a message delivered twice (same update id) is run once", async () => {
  const h = harness();
  const topic = createSystemTopic(h.deps);
  h.batches.push([message(500, "status")]);
  await topic.tick();
  // Telegram re-delivers it, e.g. because the offset was lost: the stored offset says it is old, and the audit row says it ran.
  h.store.state.pollOffset = null;
  h.batches.push([message(500, "status")]);
  await topic.tick();
  assert.equal(h.runs.length, 1);
  assert.equal(h.sent.length, 1);
});

test("the stored offset is passed to the next getUpdates", async () => {
  const h = harness();
  const topic = createSystemTopic(h.deps);
  h.batches.push([message(600, "help", { from: 5 }), message(601, "help", { from: 5 })]);
  await topic.tick();
  await topic.tick();
  assert.deepEqual(h.getUpdatesCalls, [{ offset: null }, { offset: 602 }]);
});

test("AC-SYS-13: with the switch off, outside the Mac service, without the token or without an id, no Telegram call is made", async () => {
  const variants = [
    harness({ state: { listening: false } }),
    harness({ service: false }),
    harness({ token: null }),
    harness({ state: { threadId: null } }),
    harness({ state: { ownerUserId: null } }),
    harness({ state: { chatId: null } }),
  ];
  for (const h of variants) {
    h.batches.push([message(700, "status")]);
    assert.deepEqual(await createSystemTopic(h.deps).tick(), { polled: false });
    assert.equal(h.getUpdatesCalls.length, 0);
    assert.equal(h.sent.length, 0);
  }
});

test("AC-SYS-14: a failed poll whose error carries the token leaves it in no stored error, thrown error, reply or log", async () => {
  const h = harness();
  h.batches.push(new Error(`request to https://api.telegram.org/bot${TOKEN}/getUpdates failed`));
  const error = await createSystemTopic(h.deps)
    .tick()
    .then(() => null, (e: unknown) => e);
  assert.ok(error instanceof Error);
  const everything = [error.message, error.stack ?? "", h.store.state.lastPollError ?? "", JSON.stringify(h.logs), JSON.stringify(await createSystemTopic(h.deps).view())].join(" ");
  assert.ok(!everything.includes(TOKEN));
  assert.ok(!everything.includes(TOKEN.split(":")[1]));
  assert.match(h.store.state.lastPollError ?? "", /bot<redacted>/);
});

test("AC-SYS-14: a status output that echoes the token is posted without it", async () => {
  const h = harness({ result: { output: `env: TOKEN=${TOKEN}`, exitCode: 0, timedOut: false, error: null } });
  h.batches.push([message(800, "status")]);
  await createSystemTopic(h.deps).tick();
  assert.ok(!h.sent[0].text.includes(TOKEN));
  assert.ok(!(h.store.rows.get(800)!.resultText ?? "").includes(TOKEN));
});

test("view: hasToken and the bot id, never the token", async () => {
  const h = harness();
  const view = await createSystemTopic(h.deps).view();
  assert.equal(view.hasToken, true);
  assert.equal(view.botId, "1234567890");
  assert.equal(view.active, true);
  assert.ok(!JSON.stringify(view).includes(TOKEN.split(":")[1]));
});

test("saveSettings: turning listening on outside the Mac service is refused (system_topic_needs_service), nothing saved", async () => {
  const h = harness({ service: false, state: { listening: false } });
  const input = { ownerUserId: String(OWNER), chatId: String(CHAT), threadId: String(TOPIC), listening: true, commandsPath: CONFIG_PATH };
  await assert.rejects(createSystemTopic(h.deps).saveSettings(input), (e: unknown) => isDomainError(e) && e.code === "system_topic_needs_service");
  assert.equal(h.store.state.listening, false);
});

test("saveSettings: listening without the token or an id is refused (system_topic_incomplete); off it saves anything valid", async () => {
  const noToken = harness({ token: null, state: { listening: false } });
  const full = { ownerUserId: String(OWNER), chatId: String(CHAT), threadId: String(TOPIC), listening: true, commandsPath: CONFIG_PATH };
  await assert.rejects(createSystemTopic(noToken.deps).saveSettings(full), (e: unknown) => isDomainError(e) && e.code === "system_topic_incomplete");
  const noTopic = harness({ state: { listening: false } });
  await assert.rejects(createSystemTopic(noTopic.deps).saveSettings({ ...full, threadId: "" }), (e: unknown) => isDomainError(e) && e.code === "system_topic_incomplete");
  const view = await createSystemTopic(noTopic.deps).saveSettings({ ...full, listening: false, threadId: " " });
  assert.equal(view.threadId, null);
  assert.equal(view.listening, false);
  const on = await createSystemTopic(noTopic.deps).saveSettings(full);
  assert.equal(on.listening, true);
  assert.equal(on.active, true);
});

test("saveSettings: ids must be numbers (the group's negative), the path absolute", async () => {
  const h = harness({ state: { listening: false } });
  const base = { ownerUserId: String(OWNER), chatId: String(CHAT), threadId: String(TOPIC), listening: false, commandsPath: CONFIG_PATH };
  for (const bad of [{ ownerUserId: "abc" }, { chatId: "1001234567890" }, { threadId: "-4" }, { commandsPath: "relative/commands.json" }, { extra: 1 }]) {
    await assert.rejects(createSystemTopic(h.deps).saveSettings({ ...base, ...bad }), (e: unknown) => isDomainError(e) && e.code === "validation_failed", JSON.stringify(bad));
  }
});

test("setToken refuses a text that is not a bot token; a valid one is stored and only hasToken shows", async () => {
  const h = harness({ token: null });
  const topic = createSystemTopic(h.deps);
  await assert.rejects(topic.setToken({ token: "hello" }), (e: unknown) => isDomainError(e) && e.code === "validation_failed");
  const view = await topic.setToken({ token: ` ${TOKEN} ` });
  assert.equal(view.hasToken, true);
  assert.equal((await topic.clearToken()).hasToken, false);
});
