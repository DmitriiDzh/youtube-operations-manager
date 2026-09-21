import { YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import { getLiveWritesEnabled } from "@/lib/db";
import { resolveGoogleCredentials } from "@/lib/video-metadata/adapters/google-auth";
import type { CredentialRef } from "@/lib/video-metadata/contracts";
import type { WriteExecutor } from "../contracts";
import { createAuthorizedClient } from "./youtube-api";
import { createYoutubeWriteExecutor } from "./write-executor.youtube";

/**
 * Layer 1 of the two-layer live-write barrier (docs/TECHNICAL_DEBT.md RISK-09/Gate B, owner
 * instruction 2026-09-21 -- the Settings tab "live writes" toggle). A real `WriteExecutor` is
 * constructed ONLY when the persisted setting is on at the moment this is called -- no
 * production code path (the new Batches "Apply" route) reaches `createYoutubeWriteExecutor`
 * otherwise, mirroring how `src/lib/batches/index.ts` never constructed one at all before this.
 * Layer 2 is `assertLiveWritesAuthorized()` inside the executor itself (`write-executor.youtube.ts`),
 * which re-reads the identical setting independently, immediately before any `videos.update`
 * call -- two separate reads of the same flag are the point (a stale cache or a bad read in one
 * layer doesn't defeat the other).
 */
export async function createLiveWriteExecutorIfEnabled(credentialRef: CredentialRef): Promise<WriteExecutor | null> {
  if (!(await getLiveWritesEnabled())) return null;

  return createYoutubeWriteExecutor({
    getClient: async () => {
      const credentials = await resolveGoogleCredentials({ credentialRef, requiredScopes: [YOUTUBE_WRITE_SCOPE] });
      return createAuthorizedClient(credentials);
    },
  });
}
