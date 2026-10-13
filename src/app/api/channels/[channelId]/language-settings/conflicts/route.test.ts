import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createLanguageSettingsConflictsHandlers, type LanguageSettingsConflictsDeps } from "./route";

// BL-178 part B (review item 8): a Web session is required; only the active channel (ADR 0004); a choice names a known field
// and a writer -- the value is never taken from the request.

const ctx = (channelId: string) => ({ params: Promise.resolve({ channelId }) });
const post = (body: unknown) => new Request("http://x/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function handlers(overrides: Partial<LanguageSettingsConflictsDeps> = {}) {
  const resolved: unknown[] = [];
  const deps: LanguageSettingsConflictsDeps = {
    getSession: async () => ({ user: { id: "u1" } }),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_active") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "Not the active channel" });
    },
    core: () => ({
      listConflicts: async () => [{ field: "defaultLanguage", values: ["en", "es"], valuesByActor: { a1: "en", b2: "es" }, thisComputer: "es" }],
      resolveConflict: async (input) => {
        resolved.push(input);
        return { defaultLanguage: "en", defaultAudioLanguage: "en", trackedLanguages: [] };
      },
    }),
    ...overrides,
  };
  return { ...createLanguageSettingsConflictsHandlers(deps), resolved };
}

test("401 without a session, for reading and for choosing", async () => {
  const h = handlers({ getSession: async () => null });
  assert.equal((await h.GET(new Request("http://x/"), ctx("UC_active"))).status, 401);
  assert.equal((await h.POST(post({ field: "defaultLanguage", winningActorId: "a1" }), ctx("UC_active"))).status, 401);
  assert.deepEqual(h.resolved, []);
});

test("another channel than the active one is refused; nothing is resolved", async () => {
  const h = handlers();
  assert.notEqual((await h.GET(new Request("http://x/"), ctx("UC_other"))).status, 200);
  assert.notEqual((await h.POST(post({ field: "defaultLanguage", winningActorId: "a1" }), ctx("UC_other"))).status, 200);
  assert.deepEqual(h.resolved, []);
});

test("an unknown field, a missing writer, or a raw value instead of a writer is a 400; a valid choice names field and writer only", async () => {
  const h = handlers();
  for (const body of [{ field: "title", winningActorId: "a1" }, { field: "defaultLanguage" }, { field: "defaultLanguage", value: "en" }]) {
    assert.equal((await h.POST(post(body), ctx("UC_active"))).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(h.resolved, []);
  const ok = await h.POST(post({ field: "defaultLanguage", winningActorId: "a1" }), ctx("UC_active"));
  assert.equal(ok.status, 200);
  assert.deepEqual(h.resolved, [{ channelId: "UC_active", field: "defaultLanguage", winningActorId: "a1" }]);
  const listed = await (await h.GET(new Request("http://x/"), ctx("UC_active"))).json();
  assert.equal(listed.conflicts[0].thisComputer, "es");
});
