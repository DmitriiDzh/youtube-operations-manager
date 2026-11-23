import assert from "node:assert/strict";
import test from "node:test";
import { withAgentSessionForTests } from "@/lib/agent-session";
import { assertAgentScopeWriteChannel } from "@/lib/channel-access";
import { isDomainError } from "@/lib/shared-domain";
import { createPlaylistManagementCore } from "./index";
import { createPlaylistManagementServices } from "./services";

// Owner, Telegram msg 4782 (2026-11-23), amending ADR 0048 rule 2: the channel agents (and the Producer, which calls these tools in
// one channel's agent scope) edit their channel's playlists -- add and remove its videos, and make a playlist public or private.
// Expected behavior from that requirement, not from the code:
// - in an agent scope `public` is accepted for playlist_create / playlist_update (it was refused with AGENT_PUBLIC_NOT_ALLOWED before);
// - another channel's expectedChannelId is refused (WRITE_CHANNEL_MISMATCH, the guardrail's code) before any credential or YouTube call;
// - outside an agent scope (the owner) nothing of this applies.
// (Which videos the Producer may add -- only the channel's own -- is checked on its endpoint: producer-mcp-endpoint.test.ts. A worker's
// added video ids are not checked: docs/TECHNICAL_DEBT.md RISK-158.)

const BOUND = { tokenId: "t-1", channelId: "UC_ACTIVE", userId: "user-1" };
const codeIs = (expected: string) => (error: unknown) => isDomainError(error) && error.code === expected;

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
      getPlaylistForUpdate: async ({ playlistId }) => {
        calls.push("read-playlist");
        return { id: playlistId, title: "T", description: "D", privacyStatus: "private", channelId: playlistId === "p-foreign" ? "UC_OTHER" : "UC_ACTIVE" };
      },
      updatePlaylist: async ({ playlistId, title, description, privacyStatus }) => {
        calls.push(`update:${privacyStatus}`);
        return { id: playlistId, title, description, privacyStatus };
      },
      getPlaylistForDelete: async () => null,
      deletePlaylist: async () => undefined,
      addVideoToPlaylist: async ({ videoId }) => {
        calls.push(`add:${videoId}`);
      },
      listPlaylistItemIdsByVideo: async () => new Map([["v-own-1", ["item-1"]]]),
      deletePlaylistItem: async ({ playlistItemId }) => {
        calls.push(`remove:${playlistItemId}`);
      },
    },
    writeContext: {
      assertWriteChannel: async () => ({ expectedChannelId: "UC_ACTIVE", activeWriteChannel: { id: "UC_ACTIVE", title: "A" }, shouldPersistSelection: false, userId: "user-1" }),
    },
    channelSelectionStore: { setSelectedChannelId: async () => undefined },
    assertScopeChannel: assertAgentScopeWriteChannel,
  });
  return { services, calls };
}

const REF = { userId: "user-1" };

test("msg 4782: in an agent scope a playlist is created public, private, unlisted or by default private", async () => {
  const { services, calls } = fixture();
  await withAgentSessionForTests(BOUND, async () => {
    for (const privacyStatus of ["public", "private", "unlisted"] as const) {
      await services.createPlaylist({ credentialRef: REF, title: privacyStatus, expectedChannelId: "UC_ACTIVE", privacyStatus });
    }
    await services.createPlaylist({ credentialRef: REF, title: "default", expectedChannelId: "UC_ACTIVE" });
  });
  assert.deepEqual(
    calls.filter((call) => call.startsWith("create:")),
    ["create:public", "create:private", "create:unlisted", "create:private"]
  );
});

test("msg 4782: in an agent scope the bound channel's playlist is made public, then private again", async () => {
  const { services, calls } = fixture();
  await withAgentSessionForTests(BOUND, async () => {
    const madePublic = await services.updatePlaylist({ credentialRef: REF, playlistId: "p1", expectedChannelId: "UC_ACTIVE", privacyStatus: "public" });
    assert.equal(madePublic.playlist.privacyStatus, "public");
    const madePrivate = await services.updatePlaylist({ credentialRef: REF, playlistId: "p1", expectedChannelId: "UC_ACTIVE", privacyStatus: "private" });
    assert.equal(madePrivate.playlist.privacyStatus, "private");
  });
  assert.deepEqual(
    calls.filter((call) => call.startsWith("update:")),
    ["update:public", "update:private"]
  );
});

test("msg 4782: in an agent scope another channel's expectedChannelId is refused before any credential or YouTube call", async () => {
  const { services, calls } = fixture();
  const other = { credentialRef: REF, expectedChannelId: "UC_OTHER" };
  await withAgentSessionForTests(BOUND, async () => {
    await assert.rejects(services.createPlaylist({ ...other, title: "X", privacyStatus: "public" }), codeIs("WRITE_CHANNEL_MISMATCH"));
    await assert.rejects(services.updatePlaylist({ ...other, playlistId: "p1", privacyStatus: "public" }), codeIs("WRITE_CHANNEL_MISMATCH"));
    await assert.rejects(services.addVideosToPlaylist({ ...other, playlistId: "p1", videoIds: ["v-own-1"] }), codeIs("WRITE_CHANNEL_MISMATCH"));
    await assert.rejects(services.removeVideosFromPlaylist({ ...other, playlistId: "p1", videoIds: ["v-own-1"] }), codeIs("WRITE_CHANNEL_MISMATCH"));
    await assert.rejects(services.deletePlaylist({ ...other, playlistId: "p1" }), codeIs("WRITE_CHANNEL_MISMATCH"));
  });
  assert.deepEqual(calls, []);
});

test("msg 4782: in an agent scope another channel's playlist under the bound channel's own id is refused, nothing written", async () => {
  const { services, calls } = fixture();
  const own = { credentialRef: REF, expectedChannelId: "UC_ACTIVE", playlistId: "p-foreign" };
  await withAgentSessionForTests(BOUND, async () => {
    await assert.rejects(services.updatePlaylist({ ...own, privacyStatus: "public" }), codeIs("WRITE_CHANNEL_MISMATCH"));
    await assert.rejects(services.addVideosToPlaylist({ ...own, videoIds: ["v-own-1"] }), codeIs("WRITE_CHANNEL_MISMATCH"));
    await assert.rejects(services.removeVideosFromPlaylist({ ...own, videoIds: ["v-own-1"] }), codeIs("WRITE_CHANNEL_MISMATCH"));
  });
  assert.deepEqual(
    calls.filter((call) => !["auth", "read-playlist"].includes(call)),
    []
  );
});

// Whose the added videos are is NOT checked in an agent scope (docs/TECHNICAL_DEBT.md RISK-158); this test claims only that the named
// ids are added to and removed from the bound channel's own playlist.
test("msg 4782: in an agent scope the named video ids are added to and removed from the bound channel's own playlist", async () => {
  const { services, calls } = fixture();
  await withAgentSessionForTests(BOUND, async () => {
    const added = await services.addVideosToPlaylist({ credentialRef: REF, playlistId: "p1", expectedChannelId: "UC_ACTIVE", videoIds: ["v-own-1", "v-own-2"] });
    assert.equal(added.added, 2);
    const removed = await services.removeVideosFromPlaylist({ credentialRef: REF, playlistId: "p1", expectedChannelId: "UC_ACTIVE", videoIds: ["v-own-1"] });
    assert.equal(removed.removed, 1);
  });
  assert.deepEqual(
    calls.filter((call) => call.startsWith("add:") || call.startsWith("remove:")),
    ["add:v-own-1", "add:v-own-2", "remove:item-1"]
  );
});

test("outside an agent scope (the owner) public and any video pass to the guardrail and YouTube", async () => {
  const { services, calls } = fixture();
  await services.createPlaylist({ credentialRef: REF, title: "X", expectedChannelId: "UC_ACTIVE", privacyStatus: "public" });
  await services.updatePlaylist({ credentialRef: REF, playlistId: "p1", expectedChannelId: "UC_ACTIVE", privacyStatus: "public" });
  await services.addVideosToPlaylist({ credentialRef: REF, playlistId: "p1", expectedChannelId: "UC_ACTIVE", videoIds: ["v-foreign"] });
  assert.deepEqual(
    calls.filter((call) => !["auth", "read-playlist"].includes(call)),
    ["create:public", "update:public", "add:v-foreign"]
  );
});

test("msg 4782: the real playlist core refuses another channel in an agent scope (the rule is wired, not only injectable)", async () => {
  const core = createPlaylistManagementCore();
  await withAgentSessionForTests(BOUND, async () => {
    await assert.rejects(core.updatePlaylist({ credentialRef: REF, playlistId: "p1", expectedChannelId: "UC_OTHER", privacyStatus: "public" }), codeIs("WRITE_CHANNEL_MISMATCH"));
    await assert.rejects(core.addVideosToPlaylist({ credentialRef: REF, playlistId: "p1", expectedChannelId: "UC_OTHER", videoIds: ["v1"] }), codeIs("WRITE_CHANNEL_MISMATCH"));
  });
});
