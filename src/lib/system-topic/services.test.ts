import assert from "node:assert/strict";
import test from "node:test";
import { isDomainError } from "@/lib/shared-domain";
import { CHAT, DIR, harness, inbound, OWNER, TOPIC } from "./test-fakes";

// BL-228 (SYSTEM_TOPIC_PLAN.md §2, ADR 0053 Amendment 1; FO-RESP-0043 H1): the hub relays the topic's messages. Only the owner in the
// one chat and topic is heard (AC-SYS-01/02: anything else is dropped silently, only a counter rises); a repeated update id gets no
// second run or reply; the relay secret is shown once and only its hash is kept (AC-SYS-14). Fakes only.

async function withSecret(h: ReturnType<typeof harness>) {
  const { secret } = await h.topic.generateRelaySecret();
  return secret;
}

test("AC-SYS-01: a message from another user in the topic: no reply, no audit row, the dropped counter rises", async () => {
  const h = harness();
  assert.deepEqual(await h.topic.handleInbound(inbound(100, "approve r1", { from: 999 })), { replies: [] });
  assert.equal(h.store.rows.size, 0);
  assert.equal(h.store.state.droppedCount, 1);
});

test("AC-SYS-02: the owner in another topic, outside any topic or in another chat is ignored the same way", async () => {
  const h = harness();
  for (const [i, m] of [inbound(200, "help", { thread: 7 }), inbound(201, "help", { thread: null }), inbound(202, "help", { chat: -100999 })].entries()) {
    assert.deepEqual(await h.topic.handleInbound(m), { replies: [] }, String(i));
  }
  assert.equal(h.store.rows.size, 0);
  assert.equal(h.store.state.droppedCount, 3);
});

test("help, the hub's commands, unknown text and wrong arguments get one line each; each is audited", async () => {
  const h = harness();
  const reply = async (id: number, text: string) => (await h.topic.handleInbound(inbound(id, text))).replies;
  assert.match((await reply(300, "/help@HubBot"))[0], /^Commands here:\n/);
  assert.deepEqual(await reply(301, "status tropico"), ["handled by the hub in each channel's topic"]);
  assert.deepEqual(await reply(302, "stop tropico plan"), ["handled by the hub in each channel's topic"]);
  assert.deepEqual(await reply(303, "go japan"), ["handled by the hub in each channel's topic"]);
  assert.deepEqual(await reply(304, "please deploy"), ["unknown command, see help"]);
  assert.deepEqual(await reply(305, "approve"), ["usage: approve <id>"]);
  assert.deepEqual([...h.store.rows.values()].map((r) => r.status), ["done", "hub", "hub", "hub", "unknown", "usage"]);
  assert.equal(h.store.rows.get(301)!.fromUserId, String(OWNER));
});

test("a duplicate update id gets no second reply and runs nothing again", async () => {
  const h = harness();
  assert.equal((await h.topic.handleInbound(inbound(400, "help"))).replies.length, 1);
  assert.deepEqual(await h.topic.handleInbound(inbound(400, "help")), { replies: [] });
  assert.equal(h.store.rows.size, 1);
});

test("the relay refuses while off, outside the Mac service, or with an id missing (system_topic_disabled)", async () => {
  for (const h of [harness({ state: { enabled: false } }), harness({ service: false }), harness({ state: { threadId: null } })]) {
    await assert.rejects(h.topic.handleInbound(inbound(1, "help")), (e: unknown) => isDomainError(e) && e.code === "system_topic_disabled");
    await assert.rejects(h.topic.takeOutbox(), (e: unknown) => isDomainError(e) && e.code === "system_topic_disabled");
    assert.equal(h.store.rows.size, 0);
  }
});

test("a relayed body that is not the documented shape is validation_failed", async () => {
  const h = harness();
  for (const bad of [{}, { updateId: -1 }, { updateId: 1.5 }, { updateId: 1, text: 5 }, { updateId: 1, extra: true }]) {
    await assert.rejects(h.topic.handleInbound(bad), (e: unknown) => isDomainError(e) && e.code === "validation_failed", JSON.stringify(bad));
  }
});

test("the outbox hands each queued message out once, oldest first", async () => {
  const h = harness();
  await h.topic.enqueue("first");
  await h.topic.enqueue("second");
  assert.deepEqual((await h.topic.takeOutbox()).messages.map((m) => m.text), ["first", "second"]);
  assert.deepEqual(await h.topic.takeOutbox(), { messages: [] });
});

test("AC-SYS-14: the relay secret is returned once, stored only as its SHA-256, never in the view or a log", async () => {
  const h = harness();
  const secret = await withSecret(h);
  assert.match(secret, /^ytmrelay_[A-Za-z0-9_-]{43}$/);
  assert.match(h.store.state.relaySecretHash ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(h.store.state.relaySecretHash, secret);
  const view = await h.topic.view();
  assert.deepEqual(view.relaySecret, { set: true, createdAt: new Date(h.clock.now).toISOString() });
  const everything = JSON.stringify([view, h.logs, h.store.state]);
  assert.ok(!everything.includes(secret));
  assert.ok(!everything.includes(secret.slice("ytmrelay_".length)));
});

test("the bearer check: only `Bearer <the current secret>` passes; a regenerated secret replaces the old one", async () => {
  const h = harness();
  assert.equal(await h.topic.verifyRelayAuthorization("Bearer anything"), false, "no secret set yet");
  const first = await withSecret(h);
  assert.equal(await h.topic.verifyRelayAuthorization(`Bearer ${first}`), true);
  for (const wrong of [null, "", first, `Basic ${first}`, `Bearer ${first}x`, `Bearer ${first.slice(0, -1)}`, "Bearer "]) {
    assert.equal(await h.topic.verifyRelayAuthorization(wrong), false, String(wrong));
  }
  h.clock.now += 1000;
  const second = await withSecret(h);
  assert.equal(await h.topic.verifyRelayAuthorization(`Bearer ${first}`), false);
  assert.equal(await h.topic.verifyRelayAuthorization(`Bearer ${second}`), true);
});

test("saveSettings: on outside the Mac service is refused (needs_service), without an id (incomplete); ids are numbers", async () => {
  const input = { ownerUserId: String(OWNER), chatId: String(CHAT), threadId: String(TOPIC), enabled: true, requestsPath: DIR };
  const off = harness({ service: false, state: { enabled: false } });
  await assert.rejects(off.topic.saveSettings(input), (e: unknown) => isDomainError(e) && e.code === "system_topic_needs_service");
  assert.equal(off.store.state.enabled, false);
  const h = harness({ state: { enabled: false } });
  await assert.rejects(h.topic.saveSettings({ ...input, threadId: "" }), (e: unknown) => isDomainError(e) && e.code === "system_topic_incomplete");
  for (const bad of [{ ownerUserId: "abc" }, { chatId: "1001234567890" }, { threadId: "-4" }, { requestsPath: "relative/requests" }, { extra: 1 }]) {
    await assert.rejects(h.topic.saveSettings({ ...input, ...bad }), (e: unknown) => isDomainError(e) && e.code === "validation_failed", JSON.stringify(bad));
  }
  const view = await h.topic.saveSettings(input);
  assert.equal(view.enabled, true);
  assert.equal(view.active, false, "no relay secret yet");
});
