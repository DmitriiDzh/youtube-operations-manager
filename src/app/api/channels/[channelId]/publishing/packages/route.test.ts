import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/shared-domain";
import { createPublishingPackagesHandler } from "./route";
import { createPackageThumbnailHandler } from "./thumbnail/route";

// BL-182 stage 2: a Web session is required and only the active channel's packages and thumbnails are read (ADR 0004, AGENTS.md §F).

const ctx = (channelId: string) => ({ params: Promise.resolve({ channelId }) });
const assertActiveChannel = async ({ channelId }: { channelId: string }) => {
  if (channelId !== "UC_active") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "Not the active channel" });
};

test("packages: 401 without a session, refused for another channel, the scan of the active channel otherwise", async () => {
  const scanned: string[] = [];
  const scan = async (channelId: string) => {
    scanned.push(channelId);
    return { status: "no_workspace" as const };
  };
  assert.equal((await createPublishingPackagesHandler({ getSession: async () => null, assertActiveChannel, scan })(new Request("http://x/"), ctx("UC_active"))).status, 401);
  const handler = createPublishingPackagesHandler({ getSession: async () => ({ user: { id: "u1" } }), assertActiveChannel, scan });
  assert.notEqual((await handler(new Request("http://x/"), ctx("UC_other"))).status, 200);
  const ok = await handler(new Request("http://x/"), ctx("UC_active"));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { status: "no_workspace" });
  assert.deepEqual(scanned, ["UC_active"]);
});

test("thumbnail: the image with its type, 404 when there is none, never for another channel", async () => {
  const reads: string[] = [];
  const handler = createPackageThumbnailHandler({
    getSession: async () => ({ user: { id: "u1" } }),
    assertActiveChannel,
    readThumbnail: async (_channelId, path) => {
      reads.push(path);
      return path === "04 Videos/a/t.jpg" ? { bytes: new Uint8Array([0xff, 0xd8, 0xff]), contentType: "image/jpeg" } : null;
    },
  });
  const ok = await handler(new Request("http://x/?path=04%20Videos%2Fa%2Ft.jpg"), ctx("UC_active"));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
  assert.equal((await handler(new Request("http://x/?path=other.jpg"), ctx("UC_active"))).status, 404);
  assert.notEqual((await handler(new Request("http://x/?path=04%20Videos%2Fa%2Ft.jpg"), ctx("UC_other"))).status, 200);
  assert.deepEqual(reads, ["04 Videos/a/t.jpg", "other.jpg"]);
});
