import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createLocalVideoCleanupHandlers } from "./handlers";

// BL-238 (ADR 0058 §5): the owner's switch -- signed in, the active channel only, exactly `{ enabled: boolean }`.

const view = { channelId: "UC1", enabled: true, enabledAt: null, freedBytes: 0, deletedCount: 0, waiting: [], recent: [] };
function setup(opts: { session?: boolean; activeFails?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const handlers = createLocalVideoCleanupHandlers({
    getSession: async () => (opts.session === false ? null : { user: { id: "u1" } }),
    assertActiveChannel: async (args) => {
      calls.push(["active", args]);
      if (opts.activeFails) throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
    },
    core: () => ({
      view: async (channelId) => (calls.push(["view", channelId]), { ...view, channelId }),
      setEnabled: async (channelId, enabled) => (calls.push(["set", { channelId, enabled }]), { enabled, enabledAt: enabled ? 1 : null }),
    }),
  });
  return { handlers, calls };
}
const ctx = { params: Promise.resolve({ channelId: "UC1" }) };
const put = (body: unknown) => new Request("http://x/api/channels/UC1/local-video-cleanup", { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body) });

test("signed out: 401, nothing read or changed", async () => {
  const { handlers, calls } = setup({ session: false });
  assert.equal((await handlers.GET(new Request("http://x"), ctx)).status, 401);
  assert.equal((await handlers.PUT(put({ enabled: true }), ctx)).status, 401);
  assert.deepEqual(calls, []);
});

test("another channel than the active one: refused before anything is changed", async () => {
  const { handlers, calls } = setup({ activeFails: true });
  assert.notEqual((await handlers.PUT(put({ enabled: true }), ctx)).status, 200);
  assert.ok(!calls.some(([k]) => k === "set"));
});

test("PUT takes exactly { enabled: boolean }", async () => {
  const { handlers, calls } = setup();
  for (const bad of [{}, { enabled: "yes" }, { enabled: true, extra: 1 }, "not json", null]) assert.equal((await handlers.PUT(put(bad), ctx)).status, 400, JSON.stringify(bad));
  assert.ok(!calls.some(([k]) => k === "set"));
  const ok = await handlers.PUT(put({ enabled: true }), ctx);
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.filter(([k]) => k === "set"), [["set", { channelId: "UC1", enabled: true }]]);
});
