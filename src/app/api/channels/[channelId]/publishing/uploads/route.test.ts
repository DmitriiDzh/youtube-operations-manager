import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { DEFAULT_PUBLISHING_SETTINGS } from "@/lib/publishing/settings";
import { createPublishingUploadsHandlers } from "./route";
import { createCancelUploadHandler } from "./[uploadId]/cancel/route";
import { createMoveUploadHandler } from "./[uploadId]/move/route";

// BL-182 stage 2: a Web session and the active channel are required to list, approve or cancel (ADR 0004, AGENTS.md §F); the
// approver is the session's user; a body without items or the shown settings is a 400 and approves nothing.

const ctx = (channelId: string) => ({ params: Promise.resolve({ channelId }) });
const post = (body: unknown) => new Request("http://x/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const assertActiveChannel = async ({ channelId }: { channelId: string }) => {
  if (channelId !== "UC_active") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "Not the active channel" });
};
const body = { items: [{ manifestPath: "04 Videos/a/V65_release.json", manifestSha256: "sha", publishAt: null }], shownSettings: DEFAULT_PUBLISHING_SETTINGS };

test("approve: 401 without a session, refused for another channel, the session's user approves otherwise", async () => {
  const approved: unknown[] = [];
  const make = (session: { user: { id: string } } | null) =>
    createPublishingUploadsHandlers({
      getSession: async () => session,
      assertActiveChannel,
      list: async () => [],
      approve: async (input) => {
        approved.push(input);
        return { uploads: [] };
      },
    });
  assert.equal((await make(null).POST(post(body), ctx("UC_active"))).status, 401);
  const h = make({ user: { id: "u-owner" } });
  assert.notEqual((await h.POST(post(body), ctx("UC_other"))).status, 200);
  assert.equal((await h.POST(post({ items: body.items }), ctx("UC_active"))).status, 400, "the shown settings are required");
  assert.equal((await h.POST(post({ ...body, items: [{ manifestPath: "x" }] }), ctx("UC_active"))).status, 400);
  assert.equal((await h.POST(post(body), ctx("UC_active"))).status, 200);
  assert.deepEqual(approved, [{ channelId: "UC_active", userId: "u-owner", items: body.items, shownSettings: DEFAULT_PUBLISHING_SETTINGS, acknowledgeUnknownQuota: false }]);
});

test("a refusal keeps its code and status (409 for a changed package)", async () => {
  const h = createPublishingUploadsHandlers({
    getSession: async () => ({ user: { id: "u" } }),
    assertActiveChannel,
    list: async () => [],
    approve: async () => {
      throw new DomainError({ code: "upload_package_changed", message: "changed" });
    },
  });
  const res = await h.POST(post(body), ctx("UC_active"));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, "upload_package_changed");
});

// BL-244 (ADR 0064, AC-STOP-12): the owner's cancel / stop goes through the queue control as the owner -- the session's user is the
// actor; a refusal keeps its code (409 not cancellable, 404 another channel's or unknown).
test("cancel: only the active channel; the session's user stops it; 409 when the upload may be on YouTube, 404 when not found", async () => {
  const calls: unknown[] = [];
  const handler = createCancelUploadHandler({
    getSession: async () => ({ user: { id: "u-owner" } }),
    assertActiveChannel,
    cancel: async (input, userId) => {
      calls.push([input, userId]);
      if (input.uploadId === "sent-1") throw new DomainError({ code: "upload_not_cancellable", message: "last chunk sent", details: { reason: "final_chunk_sent" } });
      if (input.uploadId === "other-1") throw new DomainError({ code: "upload_not_found", message: "not here" });
      return { uploadId: input.uploadId, status: "cancelled", previousStatus: "uploading" };
    },
  });
  const ctx2 = (channelId: string, uploadId: string) => ({ params: Promise.resolve({ channelId, uploadId }) });
  const ok = await handler(new Request("http://x/", { method: "POST" }), ctx2("UC_active", "sending-1"));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { cancelled: true, uploadId: "sending-1", status: "cancelled", previousStatus: "uploading" });
  const refused = await handler(new Request("http://x/", { method: "POST" }), ctx2("UC_active", "sent-1"));
  assert.deepEqual([refused.status, (await refused.json()).error], [409, "upload_not_cancellable"]);
  assert.equal((await handler(new Request("http://x/", { method: "POST" }), ctx2("UC_active", "other-1"))).status, 404);
  assert.notEqual((await handler(new Request("http://x/", { method: "POST" }), ctx2("UC_other", "sending-1"))).status, 200);
  assert.deepEqual(calls, [
    [{ channelId: "UC_active", uploadId: "sending-1" }, "u-owner"],
    [{ channelId: "UC_active", uploadId: "sent-1" }, "u-owner"],
    [{ channelId: "UC_active", uploadId: "other-1" }, "u-owner"],
  ]);
  const anonymous = createCancelUploadHandler({ getSession: async () => null, assertActiveChannel, cancel: async () => ({}) });
  assert.equal((await anonymous(new Request("http://x/", { method: "POST" }), ctx2("UC_active", "sending-1"))).status, 401);
});

test("release: only the active channel; 409 for an upload whose outcome is not unknown", async () => {
  const { createReleaseUploadHandler } = await import("./[uploadId]/release/route");
  const handler = createReleaseUploadHandler({ getSession: async () => ({ user: { id: "u" } }), assertActiveChannel, release: async (_c, id) => id === "unknown-1" });
  const ctx2 = (channelId: string, uploadId: string) => ({ params: Promise.resolve({ channelId, uploadId }) });
  assert.equal((await handler(new Request("http://x/", { method: "POST" }), ctx2("UC_active", "unknown-1"))).status, 200);
  assert.equal((await handler(new Request("http://x/", { method: "POST" }), ctx2("UC_active", "done-1"))).status, 409);
  assert.notEqual((await handler(new Request("http://x/", { method: "POST" }), ctx2("UC_other", "unknown-1"))).status, 200);
});

// BL-239 (UPLOAD_QUEUE_CONTROL_PLAN.md AC-UQ-12; owner msg 3930): the owner's ↑/↓ -- a Web session and the active channel, the
// direction up or down only, the session's user as the actor; a row that is not queued keeps its 409.
test("AC-UQ-12: move -- 401 without a session, refused for another channel, up/down only, the owner as the actor", async () => {
  const moved: unknown[] = [];
  const make = (session: { user: { id: string } } | null) =>
    createMoveUploadHandler({
      getSession: async () => session,
      assertActiveChannel,
      moveStep: async (input, userId) => {
        moved.push([input, userId]);
        if (input.uploadId === "started") throw new DomainError({ code: "upload_not_movable", message: "not queued" });
        return { moved: true };
      },
    });
  const at = (uploadId: string, channelId = "UC_active") => ({ params: Promise.resolve({ channelId, uploadId }) });
  assert.equal((await make(null)(post({ direction: "up" }), at("u1"))).status, 401);
  const handler = make({ user: { id: "u-owner" } });
  assert.notEqual((await handler(post({ direction: "up" }), at("u1", "UC_other"))).status, 200);
  assert.equal((await handler(post({ direction: "top" }), at("u1"))).status, 400);
  assert.equal((await handler(post({}), at("u1"))).status, 400);
  assert.equal((await handler(post({ direction: "down" }), at("u1"))).status, 200);
  const refused = await handler(post({ direction: "up" }), at("started"));
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error, "upload_not_movable");
  assert.deepEqual(moved, [
    [{ channelId: "UC_active", uploadId: "u1", direction: "down" }, "u-owner"],
    [{ channelId: "UC_active", uploadId: "started", direction: "up" }, "u-owner"],
  ]);
});
