import { test } from "node:test";
import assert from "node:assert/strict";
import { isDomainError } from "@/lib/video-metadata/contracts";
import { createChannelAccessService } from "./service";

function makeService(selections: Record<string, string | null>) {
  return createChannelAccessService({
    async getSelectedChannelId(userId: string) {
      return selections[userId] ?? null;
    },
    async setSelectedChannelId(userId: string, channelId: string) {
      selections[userId] = channelId;
    },
  });
}

test("activateChannel persists the newly active channel so a subsequent assert against it succeeds", async () => {
  const selections: Record<string, string | null> = {};
  const service = makeService(selections);
  await service.activateChannel({ userId: "user-1", channelId: "chan-new" });
  assert.equal(selections["user-1"], "chan-new");
  await assert.doesNotReject(() =>
    service.assertActiveChannel({ userId: "user-1", channelId: "chan-new" })
  );
});

// Owner's requirement (2026-09-20, Telegram): "любую информацию... исключительно по каналу
// что сейчас активен" -- any information the caller can see must be scoped exclusively to
// their currently active channel.

test("assertActiveChannel resolves when the requested channel matches the caller's active channel", async () => {
  const service = makeService({ "user-1": "chan-a" });
  const result = await service.assertActiveChannel({ userId: "user-1", channelId: "chan-a" });
  assert.equal(result, "chan-a");
});

test("assertActiveChannel fails closed when the requested channel is a different, previously-known channel", async () => {
  const service = makeService({ "user-1": "chan-a" });
  await assert.rejects(
    () => service.assertActiveChannel({ userId: "user-1", channelId: "chan-b" }),
    (error: unknown) => isDomainError(error) && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("assertActiveChannel fails closed when the caller has never had an active channel resolved", async () => {
  const service = makeService({});
  await assert.rejects(
    () => service.assertActiveChannel({ userId: "user-never-active", channelId: "chan-a" }),
    (error: unknown) => isDomainError(error) && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("assertActiveChannel fails closed for a missing/anonymous caller identity", async () => {
  const service = makeService({});
  await assert.rejects(
    () => service.assertActiveChannel({ userId: null, channelId: "chan-a" }),
    (error: unknown) => isDomainError(error) && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("getActiveChannelId returns null for a missing identity without touching the store", async () => {
  const service = createChannelAccessService({
    async getSelectedChannelId() {
      throw new Error("must not be called for a missing userId");
    },
    async setSelectedChannelId() {
      throw new Error("not exercised by this test");
    },
  });
  assert.equal(await service.getActiveChannelId(null), null);
  assert.equal(await service.getActiveChannelId(undefined), null);
});

test("filterToActiveChannel narrows a list to only the active channel's own items", () => {
  const service = makeService({});
  const items = [
    { channelId: "chan-a", label: "a" },
    { channelId: "chan-b", label: "b" },
    { channelId: "chan-a", label: "a2" },
  ];
  assert.deepEqual(service.filterToActiveChannel(items, "chan-a"), [
    { channelId: "chan-a", label: "a" },
    { channelId: "chan-a", label: "a2" },
  ]);
});

test("filterToActiveChannel returns an empty list rather than everything when there is no active channel", () => {
  const service = makeService({});
  const items = [
    { channelId: "chan-a", label: "a" },
    { channelId: "chan-b", label: "b" },
  ];
  assert.deepEqual(service.filterToActiveChannel(items, null), []);
});
