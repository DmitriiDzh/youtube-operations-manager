import assert from "node:assert/strict";
import test from "node:test";
import { getLiveWritesEnabled } from "@/lib/db";
import { DomainError, type MetadataSyncProposal, type ResolvedCredentials } from "../contracts";
import { createYoutubeApiAdapter } from "./youtube-api";

// End-to-end check that the Gate B fix (src/lib/youtube-write-gateway, 2026-09-21) actually
// surfaces through this REAL adapter, not just through assertLiveWritesAuthorized/the gateway
// primitives in isolation (both already covered by their own unit tests). Deliberately uses
// obviously-fake credentials: if `applyMetadataProposal` ever attempted a real network call
// before checking live writes, this test would hang or fail with a connection/auth error
// instead of the expected DomainError, catching a regression in call ordering.
test("applyMetadataProposal refuses with live_writes_disabled before ever touching the network, while live writes is off", async () => {
  const alreadyEnabled = await getLiveWritesEnabled();
  assert.equal(alreadyEnabled, false, "sanity check -- every process boot forces this off");

  const adapter = createYoutubeApiAdapter();

  const credentials = {
    credentialRef: { userId: "fake-user" },
    accessToken: "fake-token",
    refreshToken: "fake-refresh",
    scopeSet: new Set<string>(),
  } as unknown as ResolvedCredentials;

  const proposal = {
    targetLanguage: "es",
    update: {
      videoId: "v1",
      snippet: { title: "T", description: "D" },
      localizations: { es: { title: "ES T", description: "ES D" } },
    },
  } as unknown as MetadataSyncProposal;

  await assert.rejects(
    () => adapter.applyMetadataProposal({ credentials, proposal }),
    (error: unknown) => error instanceof DomainError && error.code === "live_writes_disabled"
  );
});
