import assert from "node:assert/strict";
import test from "node:test";
import { getLiveWritesEnabled } from "@/lib/db";
import { DomainError, type ResolvedCredentials } from "@/lib/video-metadata/contracts";
import { createVideoDetailsYoutubeApiAdapter } from "./youtube-api";

// End-to-end check that the Gate B fix (src/lib/youtube-write-gateway, 2026-09-21) actually
// surfaces through this REAL adapter, not just through assertLiveWritesAuthorized/the gateway
// primitives in isolation (both already covered by their own unit tests). Deliberately uses
// obviously-fake credentials: if `applyPatch` ever attempted a real network call (even the
// "before" snapshot read) before checking live writes, this test would hang or fail with a
// connection/auth error instead of the expected DomainError, catching a regression in call
// ordering -- the check is the very first statement in `applyPatch`, before any network call.
test("applyPatch refuses with live_writes_disabled before ever touching the network, while live writes is off", async () => {
  const alreadyEnabled = await getLiveWritesEnabled();
  assert.equal(alreadyEnabled, false, "sanity check -- every process boot forces this off");

  const adapter = createVideoDetailsYoutubeApiAdapter();
  const credentials = { accessToken: "fake-token", refreshToken: "fake-refresh" } as unknown as ResolvedCredentials;

  await assert.rejects(
    () => adapter.applyPatch({ credentials, videoId: "v1", patch: { title: "New title" } }),
    (error: unknown) => error instanceof DomainError && error.code === "live_writes_disabled"
  );
});
