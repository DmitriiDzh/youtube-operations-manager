import assert from "node:assert/strict";
import test from "node:test";
import { withAgentSessionForTests } from "@/lib/agent-session";
import { isDomainError } from "@/lib/video-metadata/contracts";
import { createVideoMetadataCore } from "@/lib/video-metadata";
import { createChannelSyncCore } from "@/lib/channel-sync";
import { assertAgentScopeChannel, assertAgentScopeVideo } from "./agent-scope";

// docs/roadmap/plans/PHASE_12_PLAN.md AC-P12-03/07: the live reads that bypass assertActiveChannel
// (list/transcript/preview) and channel_sync's explicit-channel path are confined to the bound
// channel in an agent session, and unchanged outside one.

const BOUND = { tokenId: "t", channelId: "UC_BOUND", userId: "u-bound" };
const isCode = (code: string) => (e: unknown) => isDomainError(e) && e.code === code;

test("outside a session both checks are no-ops", async () => {
  assertAgentScopeChannel("UC_ANYTHING");
  await assertAgentScopeVideo("v-any", async () => {
    throw new Error("lookup must not run outside a session");
  });
});

test("in a session: channel must be the bound one (absent = fine), video must belong to it", async () => {
  await withAgentSessionForTests(BOUND, async () => {
    assertAgentScopeChannel(undefined);
    assertAgentScopeChannel("UC_BOUND");
    assert.throws(() => assertAgentScopeChannel("UC_OTHER"), isCode("CHANNEL_NOT_ACTIVE"));

    const lookup = async (channelId: string, videoId: string) => (channelId === "UC_BOUND" && videoId === "v-own" ? {} : null);
    await assertAgentScopeVideo("v-own", lookup);
    await assert.rejects(assertAgentScopeVideo("v-foreign", lookup), isCode("not_found"));
  });
});

test("wired cores: list/transcript/preview/syncChannel reject foreign channel or video before any credential or network use", async () => {
  const metadata = createVideoMetadataCore();
  const sync = createChannelSyncCore();
  await withAgentSessionForTests(BOUND, async () => {
    await assert.rejects(metadata.listVideos({ channelId: "UC_OTHER" }), isCode("CHANNEL_NOT_ACTIVE"));
    // Nothing is synced in this per-file test database, so no video is known to belong to the bound channel.
    await assert.rejects(metadata.getTranscript({ videoId: "v-foreign" }), isCode("not_found"));
    await assert.rejects(metadata.previewMetadata({ videoId: "v-foreign", editorialPrompt: "x" }), isCode("not_found"));
    await assert.rejects(sync.syncChannel({ channelId: "UC_OTHER" }), isCode("CHANNEL_NOT_ACTIVE"));
  });
});
