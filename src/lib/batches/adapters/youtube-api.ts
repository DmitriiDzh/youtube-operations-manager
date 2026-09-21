import { createGoogleOAuthClient } from "@/lib/auth";
import { createYoutubeClient, getVideoMetadataContext, getVideosMetadataContextBatch } from "@/lib/youtube";
import type { ResolvedCredentials } from "@/lib/video-metadata/contracts";

// Architectural decision #2 (2026-09-17 plan approval): preliminary batched metadata
// collection and the mandatory fresh per-video pre-write check are two explicitly
// separate call sites, never substituted for one another, even though both are
// ultimately implemented via src/lib/youtube.ts's existing videos.list wrappers (reused,
// not duplicated, per docs/DEVELOPMENT_PLAYBOOK.md §6.4).

export function createAuthorizedClient(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
  });

  return createYoutubeClient(oauth2);
}

export function createBatchYoutubeApiAdapter() {
  return {
    /**
     * Batched (<=50 ids/call, per AC-QUOTA-01), used ONLY for a broad preliminary pass
     * over a batch's target videos (e.g. an early overview). Its result must never be
     * used to build the actual write payload, the defaultLanguage block decision, or the
     * pre-write conflict decision for any individual video -- see
     * fetchFreshVideoContext below, which is mandatory for all three.
     */
    async fetchPreliminaryBatchContext(args: { credentials: ResolvedCredentials; videoIds: string[] }) {
      const youtube = createAuthorizedClient(args.credentials);
      return getVideosMetadataContextBatch(youtube, args.videoIds);
    },

    /**
     * Single video, not batched. This is the authoritative source for merge/conflict-
     * detection/defaultLanguage-check/backup for one video's write preparation
     * (AC-MERGE-02: never build a payload from a stale local mirror or from the
     * preliminary batched pass above -- always this fresh call).
     */
    async fetchFreshVideoContext(args: { credentials: ResolvedCredentials; videoId: string }) {
      const youtube = createAuthorizedClient(args.credentials);
      const result = await getVideoMetadataContext(youtube, args.videoId);
      if (!result) return null;

      return {
        snippet: { ...result.snippet } as Record<string, unknown>,
        localizations: result.localizations,
      };
    },
  };
}
