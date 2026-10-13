import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createPublishingSettingsConflictsHandlers, type PublishingSettingsConflictsDeps } from "./route";

// BL-182 stage 2: a Web session is required; only the active channel (ADR 0004); a choice names a publishing setting and a
// writer -- the value is never taken from the request (the BL-178 language-settings rule).

const ctx = (channelId: string) => ({ params: Promise.resolve({ channelId }) });
const post = (body: unknown) => new Request("http://x/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function handlers(overrides: Partial<PublishingSettingsConflictsDeps> = {}) {
  const resolved: unknown[] = [];
  const deps: PublishingSettingsConflictsDeps = {
    getSession: async () => ({ user: { id: "u1" } }),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_active") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "Not the active channel" });
    },
    core: () => ({
      listConflicts: async () => [{ field: "publishTimeUtc", values: ["12:00", "13:00"], valuesByActor: { a1: "12:00", b2: "13:00" } }],
      resolveConflict: async (input) => {
        resolved.push(input);
      },
    }),
    ...overrides,
  };
  return { ...createPublishingSettingsConflictsHandlers(deps), resolved };
}

test("401 without a session and another channel is refused, for reading and choosing; nothing is resolved", async () => {
  const anonymous = handlers({ getSession: async () => null });
  assert.equal((await anonymous.GET(new Request("http://x/"), ctx("UC_active"))).status, 401);
  assert.equal((await anonymous.POST(post({ field: "publishTimeUtc", winningActorId: "a1" }), ctx("UC_active"))).status, 401);
  const h = handlers();
  assert.notEqual((await h.GET(new Request("http://x/"), ctx("UC_other"))).status, 200);
  assert.notEqual((await h.POST(post({ field: "publishTimeUtc", winningActorId: "a1" }), ctx("UC_other"))).status, 200);
  assert.deepEqual([...anonymous.resolved, ...h.resolved], []);
});

test("an unknown field, a missing writer or a raw value is a 400; a valid choice names field and writer only", async () => {
  const h = handlers();
  for (const body of [{ field: "title", winningActorId: "a1" }, { field: "publishTimeUtc" }, { field: "publishTimeUtc", value: "12:00" }]) {
    assert.equal((await h.POST(post(body), ctx("UC_active"))).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(h.resolved, []);
  assert.equal((await h.POST(post({ field: "publishTimeUtc", winningActorId: "b2" }), ctx("UC_active"))).status, 200);
  assert.deepEqual(h.resolved, [{ channelId: "UC_active", field: "publishTimeUtc", winningActorId: "b2" }]);
  const listed = await (await h.GET(new Request("http://x/"), ctx("UC_active"))).json();
  assert.deepEqual(listed.conflicts[0].values, ["12:00", "13:00"]);
});
