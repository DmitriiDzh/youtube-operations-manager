import { getStoredVideo, insertVideoEditAuditEvent, upsertVideos } from "@/lib/db";
import type { VideoDetailsSnapshot } from "../contracts";

export function createVideoDetailsAuditStoreAdapter() {
  return {
    async record(args: {
      channelId: string;
      videoId: string;
      eventType: "DRY_RUN" | "BACKUP" | "RESULT" | "VERIFICATION";
      detail: unknown;
    }): Promise<void> {
      await insertVideoEditAuditEvent(args);
    },
  };
}

export function createVideoDetailsLocalCacheAdapter() {
  return {
    /** Reuses `upsertVideos` (the exact function `channel-sync` itself upserts through -- no
     * parallel write path, AGENTS.md §D). `upsertVideos` always replaces the ENTIRE row it's
     * given, so every field not touched by this edit is copied forward unchanged from the
     * current stored row first -- never blanked, never guessed. If the video was never synced
     * locally at all (no stored row), there is nothing to merge onto and nothing to preserve;
     * silently skip rather than fabricate a partial row that the next real sync would just
     * overwrite anyway. */
    async refreshVideoFields(args: {
      channelId: string;
      videoId: string;
      after: VideoDetailsSnapshot;
    }): Promise<void> {
      const current = await getStoredVideo(args.channelId, args.videoId);
      if (!current) return;

      await upsertVideos(
        [
          {
            videoId: current.videoId,
            channelId: current.channelId,
            title: args.after.title,
            description: args.after.description,
            publishedAt: current.publishedAt,
            privacyStatus: args.after.privacyStatus ?? current.privacyStatus,
            defaultLanguage: args.after.defaultLanguage,
            defaultAudioLanguage: current.defaultAudioLanguage,
            thumbnails: current.thumbnails,
            existingLocalizations: current.existingLocalizations,
            etag: args.after.etag,
            viewCount: current.viewCount,
            commentCount: current.commentCount,
            likeCount: current.likeCount,
            durationSeconds: current.durationSeconds,
            // No `?? current.publishAt` fallback (unlike `privacyStatus` above, whose real-world
            // null case is negligible): `args.after.publishAt` is a fresh, authoritative read
            // straight from YouTube (adapters/youtube-api.ts), and `null` there is a genuine,
            // meaningful fact -- "YouTube confirms this video is not currently scheduled" (either
            // now public, or its schedule was cancelled) -- not "unknown, keep the old value".
            // Falling back to `current.publishAt` would silently keep a stale scheduled date after
            // it stopped being true, the exact wrong-direction version of the bug this field's
            // whole merge-preservation exists to prevent (independent review, 2026-09-26).
            publishAt: args.after.publishAt,
          },
        ],
        // Deliberately the ORIGINAL row's own lastSyncedAt, not "now" -- this is a targeted
        // field patch, not a full channel resync, and must not suppress
        // content-manager.tsx's AUTO_RESYNC_STALENESS_MS window for the fields this module
        // doesn't touch (viewCount/commentCount/likeCount, thumbnails, localizations).
        current.lastSyncedAt
      );
    },
  };
}
