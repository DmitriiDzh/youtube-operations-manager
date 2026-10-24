import assert from "node:assert/strict";
import test from "node:test";
import { withAgentSessionForTests } from "@/lib/agent-session";
import { assertAgentMayNotPublish } from "@/lib/channel-access";
import { isDomainError } from "@/lib/shared-domain";
import { createPlaylistManagementCore } from "./index";
import { createPlaylistManagementServices } from "./services";

// WORKER_CAPABILITIES_PLAN.md AC-WK-01..03 (ADR 0048, owner msg 3384): a channel agent never makes a playlist public; the owner
// still can. Expected behavior from the plan, not from the code: the refusal comes before any credential or YouTube call.

const BOUND = { tokenId: "t-1", channelId: "UC_ACTIVE", userId: "user-1" };
const refusedPublic = (error: unknown) => isDomainError(error) && error.code === "AGENT_PUBLIC_NOT_ALLOWED";

function fixture() {
  const calls: string[] = [];
  const services = createPlaylistManagementServices({
    authResolver: {
      resolve: async (args) => {
        calls.push("auth");
        return { credentialRef: args.credentialRef as { userId: string }, accessToken: "a", refreshToken: "r", tokenExpiry: 0, scopeSet: new Set(args.requiredScopes) };
      },
    },
    youtubeApi: {
      listPlaylists: async () => [],
      createPlaylist: async ({ title, description, privacyStatus }) => {
        calls.push(`create:${privacyStatus}`);
        return { id: "p-new", title, description: description ?? "", privacyStatus };
      },
      getPlaylistForUpdate: async ({ playlistId }) => ({ id: playlistId, title: "T", description: "D", privacyStatus: "public", channelId: "UC_ACTIVE" }),
      updatePlaylist: async ({ playlistId, title, description, privacyStatus }) => {
        calls.push(`update:${privacyStatus}`);
        return { id: playlistId, title, description, privacyStatus };
      },
      getPlaylistForDelete: async () => null,
      deletePlaylist: async () => undefined,
      addVideoToPlaylist: async () => undefined,
      listPlaylistItemIdsByVideo: async () => new Map(),
      deletePlaylistItem: async () => undefined,
    },
    writeContext: {
      assertWriteChannel: async () => ({ expectedChannelId: "UC_ACTIVE", activeWriteChannel: { id: "UC_ACTIVE", title: "A" }, shouldPersistSelection: false, userId: "user-1" }),
    },
    channelSelectionStore: { setSelectedChannelId: async () => undefined },
    assertMayNotPublish: assertAgentMayNotPublish,
  });
  return { services, calls };
}

test("AC-WK-01: in a channel session, creating a public playlist is refused before any credential or YouTube call", async () => {
  const { services, calls } = fixture();
  await withAgentSessionForTests(BOUND, async () => {
    await assert.rejects(services.createPlaylist({ credentialRef: { userId: "user-1" }, title: "X", expectedChannelId: "UC_ACTIVE", privacyStatus: "public" }), refusedPublic);
  });
  assert.deepEqual(calls, []);
});

test("AC-WK-01: private, unlisted and the default (private) are created in a channel session", async () => {
  const { services, calls } = fixture();
  await withAgentSessionForTests(BOUND, async () => {
    await services.createPlaylist({ credentialRef: { userId: "user-1" }, title: "A", expectedChannelId: "UC_ACTIVE", privacyStatus: "private" });
    await services.createPlaylist({ credentialRef: { userId: "user-1" }, title: "B", expectedChannelId: "UC_ACTIVE", privacyStatus: "unlisted" });
    await services.createPlaylist({ credentialRef: { userId: "user-1" }, title: "C", expectedChannelId: "UC_ACTIVE" });
  });
  assert.deepEqual(
    calls.filter((call) => call.startsWith("create:")),
    ["create:private", "create:unlisted", "create:private"]
  );
});

test("AC-WK-02: in a channel session, setting a playlist public is refused before any call; other updates pass", async () => {
  const { services, calls } = fixture();
  await withAgentSessionForTests(BOUND, async () => {
    await assert.rejects(services.updatePlaylist({ credentialRef: { userId: "user-1" }, playlistId: "p1", expectedChannelId: "UC_ACTIVE", privacyStatus: "public" }), refusedPublic);
    assert.deepEqual(calls, []);
    await services.updatePlaylist({ credentialRef: { userId: "user-1" }, playlistId: "p1", expectedChannelId: "UC_ACTIVE", privacyStatus: "private" });
    await services.updatePlaylist({ credentialRef: { userId: "user-1" }, playlistId: "p1", expectedChannelId: "UC_ACTIVE", privacyStatus: "unlisted" });
    // No privacyStatus: nothing is made public; the playlist keeps the status it has (public in this fixture).
    await services.updatePlaylist({ credentialRef: { userId: "user-1" }, playlistId: "p1", expectedChannelId: "UC_ACTIVE", title: "New title" });
  });
  assert.deepEqual(
    calls.filter((call) => call.startsWith("update:")),
    ["update:private", "update:unlisted", "update:public"]
  );
});

test("AC-WK-03: outside a channel session (the owner) public is accepted for create and update", async () => {
  const { services, calls } = fixture();
  await services.createPlaylist({ credentialRef: { userId: "user-1" }, title: "X", expectedChannelId: "UC_ACTIVE", privacyStatus: "public" });
  await services.updatePlaylist({ credentialRef: { userId: "user-1" }, playlistId: "p1", expectedChannelId: "UC_ACTIVE", privacyStatus: "public" });
  assert.deepEqual(
    calls.filter((call) => !call.startsWith("auth")),
    ["create:public", "update:public"]
  );
});

test("AC-WK-01/02: the real playlist core refuses public in a channel session (the rule is wired, not only injectable)", async () => {
  const core = createPlaylistManagementCore();
  await withAgentSessionForTests(BOUND, async () => {
    await assert.rejects(core.createPlaylist({ credentialRef: { userId: "user-1" }, title: "X", expectedChannelId: "UC_ACTIVE", privacyStatus: "public" }), refusedPublic);
    await assert.rejects(core.updatePlaylist({ credentialRef: { userId: "user-1" }, playlistId: "p1", expectedChannelId: "UC_ACTIVE", privacyStatus: "public" }), refusedPublic);
  });
});
