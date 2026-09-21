import assert from "node:assert/strict";
import test from "node:test";
import { getLiveWritesEnabled } from "@/lib/db";
import { DomainError, type ResolvedCredentials } from "../contracts";
import { createPlaylistYoutubeApiAdapter } from "./youtube-api";

// End-to-end check that the Gate B fix (src/lib/youtube-write-gateway, 2026-09-21) actually
// surfaces through this REAL adapter for every write method, not just through
// assertLiveWritesAuthorized/the gateway primitives in isolation (both already covered by their
// own unit tests). Deliberately uses obviously-fake credentials: if a method ever attempted a
// real network call before checking live writes, this test would hang or fail with a
// connection/auth error instead of the expected DomainError, catching a regression in call
// ordering (the check must run before `createAuthorizedClient`/any network call, not after).
const credentials = { accessToken: "fake-token", refreshToken: "fake-refresh" } as unknown as ResolvedCredentials;

async function assertRefusesLiveWrites(run: () => Promise<unknown>) {
  const alreadyEnabled = await getLiveWritesEnabled();
  assert.equal(alreadyEnabled, false, "sanity check -- every process boot forces this off");

  await assert.rejects(
    run,
    (error: unknown) => error instanceof DomainError && error.code === "live_writes_disabled"
  );
}

test("createPlaylist refuses with live_writes_disabled before touching the network", async () => {
  const adapter = createPlaylistYoutubeApiAdapter();
  await assertRefusesLiveWrites(() =>
    adapter.createPlaylist({ credentials, title: "T", privacyStatus: "private" })
  );
});

test("updatePlaylist refuses with live_writes_disabled before touching the network", async () => {
  const adapter = createPlaylistYoutubeApiAdapter();
  await assertRefusesLiveWrites(() =>
    adapter.updatePlaylist({ credentials, playlistId: "PL1", title: "T", description: "", privacyStatus: "private" })
  );
});

test("deletePlaylist refuses with live_writes_disabled before touching the network", async () => {
  const adapter = createPlaylistYoutubeApiAdapter();
  await assertRefusesLiveWrites(() => adapter.deletePlaylist({ credentials, playlistId: "PL1" }));
});

test("addVideoToPlaylist refuses with live_writes_disabled before touching the network", async () => {
  const adapter = createPlaylistYoutubeApiAdapter();
  await assertRefusesLiveWrites(() =>
    adapter.addVideoToPlaylist({ credentials, playlistId: "PL1", videoId: "v1" })
  );
});

test("deletePlaylistItem refuses with live_writes_disabled before touching the network", async () => {
  const adapter = createPlaylistYoutubeApiAdapter();
  await assertRefusesLiveWrites(() => adapter.deletePlaylistItem({ credentials, playlistItemId: "PLI1" }));
});
