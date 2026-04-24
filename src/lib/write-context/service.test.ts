import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "@/lib/video-metadata/contracts";
import { createWriteContextService } from "./service";

function makeCredentials() {
  return {
    credentialRef: { userId: "user-1" as const },
    accessToken: "access",
    refreshToken: "refresh",
    tokenExpiry: undefined,
    scopeSet: new Set<string>(),
  };
}

test("assertWriteChannel prefers explicit expectedChannelId over stored selection", async () => {
  const service = createWriteContextService({
    youtubeApi: {
      getActiveChannel: async () => ({ id: "UC_EXPLICIT", title: "Explicit channel" }),
    },
    channelSelectionStore: {
      getSelectedChannelId: async () => "UC_STORED",
      setSelectedChannelId: async () => undefined,
    },
  });

  const result = await service.assertWriteChannel({
    credentialRef: { userId: "user-1" },
    credentials: makeCredentials(),
    expectedChannelId: "UC_EXPLICIT",
  });

  assert.equal(result.expectedChannelId, "UC_EXPLICIT");
  assert.equal(result.context.source, "explicit");
});

test("assertWriteChannel fails with WRITE_CHANNEL_REQUIRED when expected channel is missing", async () => {
  const service = createWriteContextService({
    youtubeApi: {
      getActiveChannel: async () => ({ id: "UC_ACTIVE", title: "Active channel" }),
    },
    channelSelectionStore: {
      getSelectedChannelId: async () => null,
      setSelectedChannelId: async () => undefined,
    },
  });

  await assert.rejects(
    () =>
      service.assertWriteChannel({
        credentialRef: { userId: "user-1" },
        credentials: makeCredentials(),
      }),
    (error: unknown) => error instanceof DomainError && error.code === "WRITE_CHANNEL_REQUIRED"
  );
});

test("assertWriteChannel fails with WRITE_CHANNEL_MISMATCH when active and expected differ", async () => {
  const service = createWriteContextService({
    youtubeApi: {
      getActiveChannel: async () => ({ id: "UC_ACTIVE", title: "Active channel" }),
    },
    channelSelectionStore: {
      getSelectedChannelId: async () => "UC_STORED",
      setSelectedChannelId: async () => undefined,
    },
  });

  await assert.rejects(
    () =>
      service.assertWriteChannel({
        credentialRef: { userId: "user-1" },
        credentials: makeCredentials(),
        expectedChannelId: "UC_OTHER",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "WRITE_CHANNEL_MISMATCH"
  );
});

test("assertWriteChannel mismatch includes expected and active ids in details", async () => {
  const service = createWriteContextService({
    youtubeApi: {
      getActiveChannel: async () => ({ id: "UC_ACTIVE", title: "Active channel" }),
    },
    channelSelectionStore: {
      getSelectedChannelId: async () => "UC_STORED",
      setSelectedChannelId: async () => undefined,
    },
  });

  await assert.rejects(
    () =>
      service.assertWriteChannel({
        credentialRef: { userId: "user-1" },
        credentials: makeCredentials(),
        expectedChannelId: "UC_EXPECTED",
      }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "WRITE_CHANNEL_MISMATCH");
      assert.deepEqual(error.details, {
        expectedChannelId: "UC_EXPECTED",
        activeWriteChannelId: "UC_ACTIVE",
        requiresReauth: true,
        recommendedAction:
          "Reauthenticate with the expected channel or select the currently active OAuth channel.",
        alignmentStatus: "mismatch",
      });
      return true;
    }
  );
});

test("assertWriteChannel fails with WRITE_CHANNEL_UNRESOLVED when active channel cannot be resolved", async () => {
  const service = createWriteContextService({
    youtubeApi: {
      getActiveChannel: async () => null,
    },
    channelSelectionStore: {
      getSelectedChannelId: async () => "UC_EXPECTED",
      setSelectedChannelId: async () => undefined,
    },
  });

  await assert.rejects(
    () =>
      service.assertWriteChannel({
        credentialRef: { userId: "user-1" },
        credentials: makeCredentials(),
      }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "WRITE_CHANNEL_UNRESOLVED");
      assert.deepEqual(error.details, {
        expectedChannelId: "UC_EXPECTED",
        activeWriteChannelId: null,
        requiresReauth: true,
        recommendedAction: "Reauthenticate and verify the active OAuth channel, then retry.",
        alignmentStatus: "unresolved",
      });
      return true;
    }
  );
});

test("getWriteChannelContext returns matched alignment when expected equals active", async () => {
  const service = createWriteContextService({
    youtubeApi: {
      getActiveChannel: async () => ({ id: "UC_MATCHED", title: "Matched channel" }),
    },
    channelSelectionStore: {
      getSelectedChannelId: async () => "UC_MATCHED",
      setSelectedChannelId: async () => undefined,
    },
  });

  const context = await service.getWriteChannelContext({
    credentialRef: { userId: "user-1" },
    credentials: makeCredentials(),
  });

  assert.equal(context.alignment.status, "matched");
  assert.equal(context.alignment.requiresReauth, false);
  assert.equal(context.requiresReauth, false);
});

test("getWriteChannelContext returns mismatch alignment with requiresReauth", async () => {
  const service = createWriteContextService({
    youtubeApi: {
      getActiveChannel: async () => ({ id: "UC_ACTIVE", title: "Active channel" }),
    },
    channelSelectionStore: {
      getSelectedChannelId: async () => "UC_SELECTED",
      setSelectedChannelId: async () => undefined,
    },
  });

  const context = await service.getWriteChannelContext({
    credentialRef: { userId: "user-1" },
    credentials: makeCredentials(),
  });

  assert.equal(context.alignment.status, "mismatch");
  assert.equal(context.alignment.requiresReauth, true);
  assert.equal(context.requiresReauth, true);
});

test("getWriteChannelContext returns unresolved without reauth when expected is missing", async () => {
  const service = createWriteContextService({
    youtubeApi: {
      getActiveChannel: async () => ({ id: "UC_ACTIVE", title: "Active channel" }),
    },
    channelSelectionStore: {
      getSelectedChannelId: async () => null,
      setSelectedChannelId: async () => undefined,
    },
  });

  const context = await service.getWriteChannelContext({
    credentialRef: { userId: "user-1" },
    credentials: makeCredentials(),
  });

  assert.equal(context.alignment.status, "unresolved");
  assert.equal(context.alignment.requiresReauth, false);
  assert.equal(context.requiresReauth, false);
});

test("listKnownChannels merges selected + active channels with dedupe and source tagging", async () => {
  const service = createWriteContextService({
    youtubeApi: {
      getActiveChannel: async () => ({ id: "UC_ACTIVE", title: "Active channel" }),
    },
    channelSelectionStore: {
      getSelectedChannelId: async () => "UC_SELECTED",
      setSelectedChannelId: async () => undefined,
    },
  });

  const result = await service.listKnownChannels({
    credentialRef: { userId: "user-1" },
    credentials: makeCredentials(),
  });

  assert.deepEqual(result.knownChannels, [
    {
      id: "UC_ACTIVE",
      title: "Active channel",
      source: "active",
      isActive: true,
      isSelected: false,
    },
    {
      id: "UC_SELECTED",
      title: null,
      source: "selected",
      isActive: false,
      isSelected: true,
    },
  ]);
});

test("listKnownChannels dedupes same active + selected channel id", async () => {
  const service = createWriteContextService({
    youtubeApi: {
      getActiveChannel: async () => ({ id: "UC_SAME", title: "Same channel" }),
    },
    channelSelectionStore: {
      getSelectedChannelId: async () => "UC_SAME",
      setSelectedChannelId: async () => undefined,
    },
  });

  const result = await service.listKnownChannels({
    credentialRef: { userId: "user-1" },
    credentials: makeCredentials(),
  });

  assert.deepEqual(result.knownChannels, [
    {
      id: "UC_SAME",
      title: "Same channel",
      source: "active",
      isActive: true,
      isSelected: true,
    },
  ]);
});

test("selectWriteChannel persists requested selection and returns mismatch without claiming OAuth switch", async () => {
  let persistedChannelId: string | null = null;
  const service = createWriteContextService({
    youtubeApi: {
      getActiveChannel: async () => ({ id: "UC_ACTIVE", title: "Active channel" }),
    },
    channelSelectionStore: {
      getSelectedChannelId: async () => persistedChannelId,
      setSelectedChannelId: async (_userId: string, channelId: string) => {
        persistedChannelId = channelId;
      },
    },
  });

  const result = await service.selectWriteChannel({
    credentialRef: { userId: "user-1" },
    channelId: "UC_SELECTED00000000000000",
    credentials: makeCredentials(),
  });

  assert.equal(persistedChannelId, "UC_SELECTED00000000000000");
  assert.equal(result.selectedChannelId, "UC_SELECTED00000000000000");
  assert.equal(result.alignment.status, "mismatch");
  assert.equal(result.alignment.requiresReauth, true);
  assert.match(result.message, /does not match the active OAuth channel/i);
});
