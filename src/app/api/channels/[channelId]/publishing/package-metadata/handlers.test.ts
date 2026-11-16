import assert from "node:assert/strict";
import test from "node:test";
import { createPackageMetadataHandlers, type PackageMetadataRouteDeps } from "./handlers";

// BL-265 (MEDIA_GATE_PLAN.md AC-MG-34, owner part): the owner's packaging-fix route needs the owner's session and the active channel;
// a dry run previews, otherwise it applies -- always as the owner, with the etag and the per-field overrides the screen sent.

function harness(over: Partial<PackageMetadataRouteDeps> = {}) {
  const calls: Array<{ kind: string; channelId: string; input: unknown; actor: unknown }> = [];
  const handlers = createPackageMetadataHandlers({
    getSession: async () => ({ user: { id: "u-owner" } }),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_active") throw Object.assign(new Error("not active"), { code: "CHANNEL_NOT_ACTIVE" });
    },
    preview: async (channelId, input, actor) => {
      calls.push({ kind: "preview", channelId, input, actor });
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

test("AC-MG-34: no session -> 401, nothing previewed or applied", async () => {
  const h = harness({ getSession: async () => null });
  assert.equal((await h.post("UC_active", { video: "V61", dryRun: true })).status, 401);
  assert.deepEqual(h.calls, []);
});

test("AC-MG-34: a channel that is not the active one -> refused, nothing previewed or applied", async () => {
  const h = harness();
  const res = await h.post("UC_other", { video: "V61", dryRun: true });
  assert.notEqual(res.status, 200);
  assert.deepEqual(h.calls, []);
});

test("dryRun previews as the owner; otherwise applies with the etag and the overrides, as the owner", async () => {
  const h = harness();
  assert.equal((await h.post("UC_active", { video: "V61", dryRun: true })).status, 200);
  assert.equal((await h.post("UC_active", { video: "V61", expectedEtag: "e1", overwrite: ["title", 5] })).status, 200);
  assert.deepEqual(h.calls, [
    { kind: "preview", channelId: "UC_active", input: { video: "V61" }, actor: { kind: "owner", userId: "u-owner" } },
    { kind: "apply", channelId: "UC_active", input: { video: "V61", expectedEtag: "e1", overwrite: ["title"] }, actor: { kind: "owner", userId: "u-owner" } },
  ]);
  assert.equal((await h.post("UC_active", {})).status, 400);
});
