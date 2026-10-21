import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createChannelLocalizationsHandlers, type ChannelLocalizationsRouteDeps } from "./shared";

// BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md §2/§6): the owner's routes -- a Web session and the active channel first; the owner saves as
// "owner"; «Применить» passes the session's user as the credential reference; a refused save answers 400 with details.refused.

function deps(overrides: Partial<ChannelLocalizationsRouteDeps> = {}) {
  const calls: unknown[] = [];
  const base: ChannelLocalizationsRouteDeps = {
    getSession: async () => ({ user: { id: "user-1" } }),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC1") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE" as never, message: "not active" });
    },
    core: {
      view: async (channelId) => (calls.push(["view", channelId]), { channelId }) as never,
      save: async (channelId, input, by) => {
        calls.push(["save", channelId, input, by]);
        if (input && typeof input === "object" && "xx" in input) throw new DomainError({ code: "validation_failed", message: "Refused", details: { refused: [{ language: "xx" }] } });
        return { localizations: {} };
      },
      preview: async (channelId) => (calls.push(["preview", channelId]), {}) as never,
      apply: async (channelId, credentialRef, setVersion) => (calls.push(["apply", channelId, credentialRef, setVersion]), { ok: true }) as never,
    },
    ...overrides,
  };
  return { handlers: createChannelLocalizationsHandlers(base), calls };
}

const ctx = (channelId = "UC1") => ({ params: Promise.resolve({ channelId }) });
const put = (body: unknown) => new Request("http://x", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

test("no session -> 401 and the module is not called", async () => {
  const { handlers, calls } = deps({ getSession: async () => null });
  assert.equal((await handlers.APPLY(new Request("http://x", { method: "POST" }), ctx())).status, 401);
  assert.deepEqual(calls, []);
});

test("a channel that is not the active one -> 403 and the module is not called", async () => {
  const { handlers, calls } = deps();
  assert.equal((await handlers.APPLY(new Request("http://x", { method: "POST", body: "{}" }), ctx("UC2"))).status, 403);
  assert.deepEqual(calls, []);
});

test("PUT saves as the owner; a refused set answers 400 with details.refused", async () => {
  const { handlers, calls } = deps();
  assert.equal((await handlers.PUT(put({ localizations: { de: { title: "T", description: "D" } } }), ctx())).status, 200);
  const refused = await handlers.PUT(put({ localizations: { xx: {} } }), ctx());
  assert.equal(refused.status, 400);
  assert.deepEqual(((await refused.json()) as { details: unknown }).details, { refused: [{ language: "xx" }] });
  assert.deepEqual(calls[0], ["save", "UC1", { de: { title: "T", description: "D" } }, "owner"]);
});

test("POST /apply passes the session's user as the credential reference and the previewed set version (review #2)", async () => {
  const { handlers, calls } = deps();
  assert.equal((await handlers.APPLY(new Request("http://x", { method: "POST", body: JSON.stringify({ setVersion: "v1" }) }), ctx())).status, 200);
  assert.deepEqual(calls, [["apply", "UC1", { userId: "user-1" }, "v1"]]);
  assert.equal((await handlers.APPLY(new Request("http://x", { method: "POST", body: "not json" }), ctx())).status, 400);
});
