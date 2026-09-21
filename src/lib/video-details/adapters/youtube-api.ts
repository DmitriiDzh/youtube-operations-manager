import { createGoogleOAuthClient } from "@/lib/auth";
import { createYoutubeClient, getVideoDetailsContext } from "@/lib/youtube";
import {
  applyVideoDetailsUpdate,
  assertLiveWritesAuthorized,
  pickWritableRecordingDetailsFields,
  pickWritableSnippetFields,
  pickWritableStatusFields,
} from "@/lib/youtube-write-gateway";
import { DomainError, type ResolvedCredentials } from "@/lib/video-metadata/contracts";
import type { VideoDetailsPatch, VideoDetailsSnapshot } from "../contracts";

function createAuthorizedClient(credentials: ResolvedCredentials) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
  });

  return createYoutubeClient(oauth2);
}

function toSnapshot(videoId: string, context: NonNullable<Awaited<ReturnType<typeof getVideoDetailsContext>>>): VideoDetailsSnapshot {
  return {
    videoId,
    etag: context.etag,
    title: context.snippet.title ?? "",
    description: context.snippet.description ?? "",
    tags: context.snippet.tags ?? [],
    categoryId: context.snippet.categoryId ?? null,
    defaultLanguage: context.snippet.defaultLanguage ?? null,
    privacyStatus: context.status.privacyStatus ?? null,
    publishAt: context.status.publishAt ?? null,
    license: context.status.license ?? null,
    embeddable: context.status.embeddable ?? null,
    publicStatsViewable: context.status.publicStatsViewable ?? null,
    selfDeclaredMadeForKids: context.status.selfDeclaredMadeForKids ?? null,
    containsSyntheticMedia: context.status.containsSyntheticMedia ?? null,
    recordingDate: context.recordingDate,
  };
}

const SNIPPET_PATCH_KEYS = ["title", "description", "tags", "categoryId", "defaultLanguage"] as const;
const STATUS_PATCH_KEYS = [
  "privacyStatus",
  "publishAt",
  "license",
  "embeddable",
  "publicStatsViewable",
  "selfDeclaredMadeForKids",
  "containsSyntheticMedia",
] as const;

export function createVideoDetailsYoutubeApiAdapter() {
  return {
    async getSnapshot(args: { credentials: ResolvedCredentials; videoId: string }): Promise<VideoDetailsSnapshot> {
      const youtube = createAuthorizedClient(args.credentials);
      const context = await getVideoDetailsContext(youtube, args.videoId);
      if (!context) {
        throw new DomainError({
          code: "not_found",
          message: "Video not found or missing required snippet/status data",
          details: { videoId: args.videoId },
        });
      }
      return toSnapshot(args.videoId, context);
    },

    /**
     * Merges `patch` onto a freshly-fetched current snapshot and sends only the parts the
     * patch actually touches -- never `localizations` (AGENTS.md §F). Returns the post-write
     * snapshot from a second, independent read (the verification step), never assumed from the
     * request body.
     */
    async applyPatch(args: {
      credentials: ResolvedCredentials;
      videoId: string;
      patch: VideoDetailsPatch;
    }): Promise<{ before: VideoDetailsSnapshot; after: VideoDetailsSnapshot }> {
      const youtube = createAuthorizedClient(args.credentials);
      const context = await getVideoDetailsContext(youtube, args.videoId);
      if (!context) {
        throw new DomainError({
          code: "not_found",
          message: "Video not found or missing required snippet/status data",
          details: { videoId: args.videoId },
        });
      }
      const before = toSnapshot(args.videoId, context);

      if (args.patch.publishAt !== undefined && before.publishAt) {
        throw new DomainError({
          code: "publish_at_already_published",
          message: "publishAt can only be set on a video that has never been published",
          details: { videoId: args.videoId, currentPublishAt: before.publishAt },
        });
      }

      const touchesSnippet = SNIPPET_PATCH_KEYS.some((key) => key in args.patch);
      const touchesStatus = STATUS_PATCH_KEYS.some((key) => key in args.patch);
      const touchesRecordingDetails = "recordingDate" in args.patch;

      await assertLiveWritesAuthorized();

      await applyVideoDetailsUpdate({
        youtube,
        videoId: args.videoId,
        parts: {
          ...(touchesSnippet
            ? {
                snippet: pickWritableSnippetFields({
                  ...context.snippet,
                  ...args.patch,
                }) as typeof context.snippet,
              }
            : {}),
          ...(touchesStatus
            ? {
                status: pickWritableStatusFields({
                  ...context.status,
                  ...args.patch,
                }) as typeof context.status,
              }
            : {}),
          ...(touchesRecordingDetails
            ? {
                recordingDetails: pickWritableRecordingDetailsFields({
                  recordingDate: args.patch.recordingDate,
                }),
              }
            : {}),
        },
      });

      const verifiedContext = await getVideoDetailsContext(youtube, args.videoId);
      if (!verifiedContext) {
        throw new DomainError({
          code: "update_failed",
          message: "Video disappeared immediately after a successful update call",
          details: { videoId: args.videoId },
        });
      }

      return { before, after: toSnapshot(args.videoId, verifiedContext) };
    },
  };
}
