import assert from "node:assert/strict";
import test from "node:test";
import { createPackageCaptionsHandlers, type PackageCaptionsRouteDeps } from "./handlers";

// BL-269 AC-CAP-36 (VIDEO_CAPTIONS_PLAN.md §3.5, §3.7): the owner's captions route needs the owner's session and the active channel;
// a dry run previews (with `overwrite` when asked), otherwise it applies with the pins the screen sent -- always as the owner.

function harness(over: Partial<PackageCaptionsRouteDeps> = {}) {
  const calls: Array<{ kind: string; channelId: string; input: unknown; actor: unknown }> = [];
  const handlers = createPackageCaptionsHandlers({
    getSession: async () => ({ user: { id: "u-owner" } }),
    assertActiveChannel: async ({ channelId }) => {
      if (channelId !== "UC_active") throw Object.assign(new Error("not active"), { code: "CHANNEL_NOT_ACTIVE" });
    },
    preview: async (channelId, input, actor) => (calls.push({ kind: "preview", channelId, input, actor }), { dryRun: true }),
    apply: async (channelId, input, actor) => (calls.push({ kind: "apply", channelId, input, actor }), { dryRun: false }),
    ...over,
  });
  const post = (channelId: string, body: unknown) => handlers.POST(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ channelId }) });
  return { calls, post };
}

test("AC-CAP-36 no session -> 401; another channel -> refused; nothing previewed or applied", async () => {
  const none = harness({ getSession: async () => null });
  assert.equal((await none.post("UC_active", { video: "V27", dryRun: true })).status, 401);
  const other = harness();
  assert.notEqual((await other.post("UC_other", { video: "V27", dryRun: true })).status, 200);
  assert.deepEqual([none.calls, other.calls], [[], []]);
});

test("AC-CAP-36 dryRun previews (overwrite passed through); apply carries the manifest and track pins; always the owner", async () => {
  const h = harness();
  assert.equal((await h.post("UC_active", { video: "V27", dryRun: true, overwrite: true })).status, 200);
  assert.equal((await h.post("UC_active", { video: "V27", overwrite: true, expectedManifestSha256: "m1", expectedTrackId: "F1" })).status, 200);
  assert.equal((await h.post("UC_active", { video: "V27", expectedManifestSha256: "m1", expectedTrackId: null })).status, 200);
  const actor = { kind: "owner", userId: "u-owner" };
  assert.deepEqual(h.calls, [
    { kind: "preview", channelId: "UC_active", input: { video: "V27", overwrite: true }, actor },
    { kind: "apply", channelId: "UC_active", input: { video: "V27", overwrite: true, expectedManifestSha256: "m1", expectedTrackId: "F1" }, actor },
    { kind: "apply", channelId: "UC_active", input: { video: "V27", overwrite: false, expectedManifestSha256: "m1", expectedTrackId: null }, actor },
  ]);
  assert.equal((await h.post("UC_active", {})).status, 400);
});

test("a domain refusal keeps its code and status", async () => {
  const { DomainError } = await import("@/lib/shared-domain");
  const h = harness({
    apply: async () => {
      throw new DomainError({ code: "captions_foreign_track", message: "foreign", details: {} });
    },
  });
  const res = await h.post("UC_active", { video: "V27", expectedManifestSha256: "m1", expectedTrackId: null });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, "captions_foreign_track");
});
