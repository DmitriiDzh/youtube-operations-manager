import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackRequest } from "@/lib/loopback-guard";
import { harness, inbound, OWNER } from "@/lib/system-topic/test-fakes";
import { createSystemTopicHandlers, type SystemTopicRouteDeps } from "./shared";

// BL-228 (SYSTEM_TOPIC_PLAN.md, ADR 0053 Amendment 1; FO-RESP-0043 H1): the routes. The owner's need a Web session (401, the module
// is not called). The hub's relay needs a loopback request (403 forbidden_not_loopback) and `Authorization: Bearer <relay secret>`
// (401 unauthorized) and no session; a duplicate update id gets no second reply; the secret is in no answer but the one that made it.

function setup(overrides: Partial<SystemTopicRouteDeps> = {}) {
  const h = harness();
  const deps: SystemTopicRouteDeps = {
    getSession: async () => ({ user: { id: "user-1" } }),
    core: () => ({ topic: h.topic, approvals: h.approvals }),
    isLoopback: isLoopbackRequest,
    mayWrite: async () => true,
    ...overrides,
  };
  return { h, handlers: createSystemTopicHandlers(() => deps) };
}

const LOCAL = "127.0.0.1:3000";
const relay = (method: string, auth: string | null, body?: unknown, host = LOCAL) =>
  new Request(`http://${host}/api/system-topic/${method === "GET" ? "outbox" : "inbound"}`, {
    method,
    headers: { host, "content-type": "application/json", ...(auth === null ? {} : { authorization: auth }) },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function secretOf(handlers: ReturnType<typeof setup>["handlers"]) {
  const response = await handlers.POST_RELAY_SECRET(new Request("http://x", { method: "POST" }), undefined);
  return ((await response.json()) as { secret: string }).secret;
}

test("owner routes: no session -> 401 everywhere, nothing changes", async () => {
  const { h, handlers } = setup({ getSession: async () => null });
  const req = () => new Request("http://x", { method: "POST", body: "{}" });
  for (const response of [
    await handlers.GET(new Request("http://x"), undefined),
    await handlers.PUT(new Request("http://x", { method: "PUT", body: "{}" }), undefined),
    await handlers.POST_RELAY_SECRET(req(), undefined),
    await handlers.POST_CONFIRM(req(), ctx("r1")),
    await handlers.POST_DENY(req(), ctx("r1")),
  ]) {
    assert.equal(response.status, 401);
  }
  assert.equal(h.store.state.relaySecretHash, null);
});

test("AC-SYS-14: the generated secret is in that one answer only; GET shows only that one is set", async () => {
  const { handlers } = setup();
  const secret = await secretOf(handlers);
  const text = await (await handlers.GET(new Request("http://x"), undefined)).text();
  assert.ok(!text.includes(secret));
  assert.match(text, /"relaySecret":\{"set":true/);
});

test("relay: a non-loopback request is 403 forbidden_not_loopback, before the secret is even looked at", async () => {
  const { handlers } = setup();
  const secret = await secretOf(handlers);
  for (const host of ["192.168.1.20:3000", "evil.example:3000"]) {
    const response = await handlers.POST_INBOUND(relay("POST", `Bearer ${secret}`, inbound(1, "help"), host));
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { error: string }).error, "forbidden_not_loopback");
  }
  const browser = new Request(`http://${LOCAL}/api/system-topic/outbox`, { headers: { host: LOCAL, origin: "https://evil.example", authorization: `Bearer ${secret}` } });
  assert.equal((await handlers.GET_OUTBOX(browser)).status, 403);
});

test("relay: a missing or wrong bearer is 401 unauthorized and nothing is recorded", async () => {
  const { h, handlers } = setup();
  const secret = await secretOf(handlers);
  for (const auth of [null, "Bearer wrong", secret, `Bearer ${secret}x`]) {
    const response = await handlers.POST_INBOUND(relay("POST", auth, inbound(1, "help")));
    assert.equal(response.status, 401, String(auth));
    assert.equal(((await response.json()) as { error: string }).error, "unauthorized");
    assert.equal((await handlers.GET_OUTBOX(relay("GET", auth))).status, 401);
  }
  assert.equal(h.store.rows.size, 0);
  assert.equal(h.store.state.lastInboundAt, null);
});

test("relay: inbound answers { replies }; a duplicate update id gets none; a non-owner is dropped silently", async () => {
  const { h, handlers } = setup();
  const auth = `Bearer ${await secretOf(handlers)}`;
  const send = async (body: unknown) => (await (await handlers.POST_INBOUND(relay("POST", auth, body))).json()) as { replies: string[] };
  assert.deepEqual(await send(inbound(10, "go tropico")), { replies: ["handled by the hub in each channel's topic"] });
  assert.deepEqual(await send(inbound(10, "go tropico")), { replies: [] });
  assert.deepEqual(await send(inbound(11, "help", { from: OWNER + 1 })), { replies: [] });
  assert.equal(h.store.state.droppedCount, 1);
  const bad = await handlers.POST_INBOUND(relay("POST", auth, "[1]"));
  assert.equal(bad.status, 400);
  const invalid = await handlers.POST_INBOUND(relay("POST", auth, { updateId: "x" }));
  assert.equal(invalid.status, 400); // validation_failed is 400 (error-status.ts)
  assert.equal(((await invalid.json()) as { error: string }).error, "validation_failed");
});

test("relay: the outbox gives each message once; 503 while the database is busy (nothing marked delivered); 409 while off", async () => {
  const busy = { value: false };
  const { h, handlers } = setup({ mayWrite: async () => !busy.value });
  const auth = `Bearer ${await secretOf(handlers)}`;
  await h.topic.enqueue("Paid-call request r1 ...");
  busy.value = true;
  assert.equal((await handlers.GET_OUTBOX(relay("GET", auth))).status, 503);
  busy.value = false;
  assert.deepEqual(((await (await handlers.GET_OUTBOX(relay("GET", auth))).json()) as { messages: Array<{ text: string }> }).messages.map((m) => m.text), ["Paid-call request r1 ..."]);
  assert.deepEqual(await (await handlers.GET_OUTBOX(relay("GET", auth))).json(), { messages: [] });
  h.store.state.enabled = false;
  const off = await handlers.GET_OUTBOX(relay("GET", auth));
  assert.equal(off.status, 409);
  assert.equal(((await off.json()) as { error: string }).error, "system_topic_disabled");
});

test("confirm of an unknown request is 404; of one not approved in the topic is 409 system_topic_request_state", async () => {
  const { h, handlers } = setup();
  assert.equal((await handlers.POST_CONFIRM(new Request("http://x", { method: "POST" }), ctx("nope"))).status, 404);
  h.files.files.set("r1.json", (await import("@/lib/system-topic/test-fakes")).requestFile("r1"));
  await h.approvals.scan();
  const response = await handlers.POST_CONFIRM(new Request("http://x", { method: "POST" }), ctx("r1"));
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { error: string }).error, "system_topic_request_state");
  assert.equal(h.action.runs.length, 0);
});
