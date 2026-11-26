import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createCategoryFixHandlers, type CategoryFixRouteDeps } from "./handlers";

// BL-279 (owner TG 4963/4964): the owner's category fix route needs the owner's session and the active channel; a dry run previews,
// otherwise it applies as the owner, bound to the category the preview showed -- the request never names the category to write.

function harness(over: Partial<CategoryFixRouteDeps> = {}) {
  const calls: Array<{ kind: string; channelId: string; input?: unknown; actor: unknown }> = [];
  const handlers = createCategoryFixHandlers({
    getSession: async () => ({ user: { id: "u-owner" } }),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_active") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
    },
    preview: async (channelId, actor) => {
      calls.push({ kind: "preview", channelId, actor });
      return { dryRun: true };
    },
    apply: async (channelId, input, actor) => {
      calls.push({ kind: "apply", channelId, input, actor });
      return { dryRun: false };
    },
    ...over,
  });
  const post = (channelId: string, body: unknown) => handlers.POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ channelId }) });
  return { calls, post };
}

test("BL-279: no session -> 401; a channel that is not the active one -> refused; nothing previewed or applied", async () => {
  assert.equal((await harness({ getSession: async () => null }).post("UC_active", { dryRun: true })).status, 401);
  const h = harness();
  assert.notEqual((await h.post("UC_other", { dryRun: true })).status, 200);
  assert.deepEqual(h.calls, []);
});

test("BL-279: dryRun previews as the owner; otherwise applies with expectedCategoryId and videoIds only -- a categoryId in the body is ignored", async () => {
  const h = harness();
  assert.equal((await h.post("UC_active", { dryRun: true })).status, 200);
  assert.equal((await h.post("UC_active", { expectedCategoryId: "27", videoIds: ["vidA"], categoryId: "1" })).status, 200);
  assert.deepEqual(h.calls, [
    { kind: "preview", channelId: "UC_active", actor: { kind: "owner", userId: "u-owner" } },
    { kind: "apply", channelId: "UC_active", input: { expectedCategoryId: "27", videoIds: ["vidA"] }, actor: { kind: "owner", userId: "u-owner" } },
  ]);
  assert.equal((await h.post("UC_active", { videoIds: [5] })).status, 400);
});

test("BL-279: a refusal keeps its code (publishing_settings_not_saved -> 409)", async () => {
  const h = harness({
    preview: async () => {
      throw new DomainError({ code: "publishing_settings_not_saved", message: "never saved" });
    },
  });
  const res = await h.post("UC_active", { dryRun: true });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "publishing_settings_not_saved");
});
