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
