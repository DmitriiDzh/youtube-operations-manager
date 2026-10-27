import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import type { SystemTopicView } from "@/lib/system-topic/contracts";
import { createSystemTopicHandlers, type SystemTopicRouteDeps } from "./shared";

// BL-228 (SYSTEM_TOPIC_PLAN.md §2 item 3): a signed-in owner only (401 on every route, the module is not called); the body goes to the
// module as sent; a module refusal keeps its status (409 system_topic_needs_service outside the Mac service); no answer carries the
// token (AC-SYS-14), even the one to the request that saved it.

const TOKEN = "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ";
const VIEW = { hasToken: true, botId: "1234567890", listening: false } as unknown as SystemTopicView;

function deps(overrides: Partial<SystemTopicRouteDeps> = {}) {
  const calls: unknown[] = [];
  const base: SystemTopicRouteDeps = {
    getSession: async () => ({ user: { id: "user-1" } }),
    core: () => ({
      view: async () => (calls.push(["view"]), VIEW),
      saveSettings: async (input) => {
        calls.push(["save", input]);
        if ((input as { listening?: boolean }).listening) throw new DomainError({ code: "system_topic_needs_service", message: "not the service" });
        return VIEW;
      },
      setToken: async (input) => (calls.push(["token", input]), VIEW),
      clearToken: async () => (calls.push(["clear"]), VIEW),
    }),
    ...overrides,
  };
  return { handlers: createSystemTopicHandlers(() => base), calls };
}

const put = (body: string) => new Request("http://x", { method: "PUT", body, headers: { "content-type": "application/json" } });

test("no session -> 401 on every route, and the module is not called", async () => {
  const { handlers, calls } = deps({ getSession: async () => null });
  for (const response of [
    await handlers.GET(new Request("http://x")),
    await handlers.PUT(put("{\"listening\":false}")),
    await handlers.PUT_TOKEN(put(JSON.stringify({ token: TOKEN }))),
    await handlers.DELETE_TOKEN(new Request("http://x", { method: "DELETE" })),
  ]) {
    assert.equal(response.status, 401);
  }
  assert.deepEqual(calls, []);
});

test("PUT passes the body; listening outside the service answers 409 system_topic_needs_service", async () => {
  const { handlers, calls } = deps();
  const response = await handlers.PUT(put("{\"listening\":true}"));
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { error: string }).error, "system_topic_needs_service");
  assert.deepEqual(calls, [["save", { listening: true }]]);
});

test("a body that is not a JSON object is 400 and never reaches the module", async () => {
  const { handlers, calls } = deps();
  assert.equal((await handlers.PUT(put("[1]"))).status, 400);
  assert.equal((await handlers.PUT_TOKEN(put("nope"))).status, 400);
  assert.deepEqual(calls, []);
});

test("AC-SYS-14: saving the token answers with the view only -- the token is not in the response", async () => {
  const { handlers, calls } = deps();
  const response = await handlers.PUT_TOKEN(put(JSON.stringify({ token: TOKEN })));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes(TOKEN.split(":")[1]));
  assert.deepEqual(JSON.parse(text), VIEW);
  assert.deepEqual(calls, [["token", { token: TOKEN }]]);
});

test("an unexpected failure is 500 without its message (it could name anything)", async () => {
  const { handlers } = deps({
    core: () => ({
      view: async () => {
        throw new Error(`boom ${TOKEN}`);
      },
      saveSettings: async () => VIEW,
      setToken: async () => VIEW,
      clearToken: async () => VIEW,
    }),
  });
  const response = await handlers.GET(new Request("http://x"));
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes(TOKEN));
});
