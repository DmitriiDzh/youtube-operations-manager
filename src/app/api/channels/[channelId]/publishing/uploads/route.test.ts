import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { DEFAULT_PUBLISHING_SETTINGS } from "@/lib/publishing/settings";
import { createPublishingUploadsHandlers } from "./route";
import { createCancelUploadHandler } from "./[uploadId]/cancel/route";

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

test("cancel: only the active channel; 409 when the upload already reached YouTube", async () => {
  const handler = createCancelUploadHandler({ getSession: async () => ({ user: { id: "u" } }), assertActiveChannel, cancel: async (_c, id) => id === "queued-1" });
  const ctx2 = (channelId: string, uploadId: string) => ({ params: Promise.resolve({ channelId, uploadId }) });
  assert.equal((await handler(new Request("http://x/", { method: "POST" }), ctx2("UC_active", "queued-1"))).status, 200);
  assert.equal((await handler(new Request("http://x/", { method: "POST" }), ctx2("UC_active", "sent-1"))).status, 409);
  assert.notEqual((await handler(new Request("http://x/", { method: "POST" }), ctx2("UC_other", "queued-1"))).status, 200);
});

test("release: only the active channel; 409 for an upload whose outcome is not unknown", async () => {
  const { createReleaseUploadHandler } = await import("./[uploadId]/release/route");
  const handler = createReleaseUploadHandler({ getSession: async () => ({ user: { id: "u" } }), assertActiveChannel, release: async (_c, id) => id === "unknown-1" });
  const ctx2 = (channelId: string, uploadId: string) => ({ params: Promise.resolve({ channelId, uploadId }) });
  assert.equal((await handler(new Request("http://x/", { method: "POST" }), ctx2("UC_active", "unknown-1"))).status, 200);
  assert.equal((await handler(new Request("http://x/", { method: "POST" }), ctx2("UC_active", "done-1"))).status, 409);
  assert.notEqual((await handler(new Request("http://x/", { method: "POST" }), ctx2("UC_other", "unknown-1"))).status, 200);
});
