import { createGoogleOAuthClient } from "@/lib/auth";
import { createYoutubeClient, getVideoDetailsContext } from "@/lib/youtube-read-gateway";
import {
  applyVideoDetailsUpdate,
  assertLiveWritesAuthorized,
  pickWritableRecordingDetailsFields,
  pickWritableSnippetFields,
  pickWritableStatusFields,
} from "@/lib/youtube-write-gateway";
import { DomainError, type ResolvedCredentials } from "@/lib/shared-domain";
import { publishAtWriteRefusal } from "../publish-at-rule";
import { missingWriteOnlyStatusFields, readBackUntilApplied } from "../read-back";
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
    defaultAudioLanguage: context.snippet.defaultAudioLanguage ?? null,
    privacyStatus: context.status.privacyStatus ?? null,
    publishAt: context.status.publishAt ?? null,
    license: context.status.license ?? null,
    embeddable: context.status.embeddable ?? null,
    publicStatsViewable: context.status.publicStatsViewable ?? null,
    selfDeclaredMadeForKids: context.status.selfDeclaredMadeForKids ?? null,
    containsSyntheticMedia: context.status.containsSyntheticMedia ?? null,
    recordingDate: context.recordingDate,
    paidProductPlacement: context.paidProductPlacement,
  };
}

const SNIPPET_PATCH_KEYS = ["title", "description", "tags", "categoryId", "defaultLanguage", "defaultAudioLanguage"] as const;
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
      const youtube = await createAuthorizedClient(args.credentials);
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
      readBackRetries?: number;
    }): Promise<{ before: VideoDetailsSnapshot; after: VideoDetailsSnapshot }> {
      await assertLiveWritesAuthorized();

      const youtube = await createAuthorizedClient(args.credentials);
      const context = await getVideoDetailsContext(youtube, args.videoId);
      if (!context) {
        throw new DomainError({
          code: "not_found",
          message: "Video not found or missing required snippet/status data",
          details: { videoId: args.videoId },
        });
      }
      const before = toSnapshot(args.videoId, context);

      const publishAtRefusal = publishAtWriteRefusal(args.videoId, before, args.patch, Date.now());
      if (publishAtRefusal) throw publishAtRefusal;

      const touchesSnippet = SNIPPET_PATCH_KEYS.some((key) => key in args.patch);
      const touchesStatus = STATUS_PATCH_KEYS.some((key) => key in args.patch);
      // BL-182 review: `videos.update` replaces the whole status part, and YouTube never returns "AI use" on read -- a status write
      // without it in the patch would silently reset it. Fail closed: the caller must send it explicitly (the Details card does).
      const missing = missingWriteOnlyStatusFields(touchesStatus, context.status as Record<string, unknown>, args.patch as Record<string, unknown>);
      if (missing.length > 0) {
        throw new DomainError({
          code: "validation_failed",
          message: `A status change must include ${missing.join(", ")}: YouTube does not return it on read, so it would be reset`,
          details: { videoId: args.videoId, missing },
        });
      }
      const touchesRecordingDetails = "recordingDate" in args.patch;
      const touchesPaidPlacement = "paidProductPlacement" in args.patch;

      await applyVideoDetailsUpdate({
        youtube,
        videoId: args.videoId,
        parts: {
          ...(touchesSnippet
            ? {
                snippet: pickWritableSnippetFields(
                  { ...context.snippet, ...args.patch },
                  // Written when the patch changes it; otherwise the value just read is kept (RISK-102: "Fix all" changing only
                  // defaultLanguage reset the audio language to en-US, 2026-10-12) -- never a stored copy.
                  { includeDefaultAudioLanguage: "defaultAudioLanguage" in args.patch ? true : "keep" }
                ) as typeof context.snippet,
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
          ...(touchesPaidPlacement ? { paidProductPlacementDetails: { hasPaidProductPlacement: args.patch.paidProductPlacement === true } } : {}),
        },
      });

      // YouTube may serve the old value for a few seconds after the write (observed live for
      // defaultAudioLanguage) -- re-read a bounded number of times before verification judges it.
      const after = await readBackUntilApplied({
        patch: args.patch,
        ...(args.readBackRetries !== undefined ? { retries: args.readBackRetries } : {}),
        read: async () => {
          const verifiedContext = await getVideoDetailsContext(youtube, args.videoId);
          if (!verifiedContext) {
            throw new DomainError({
              code: "update_failed",
              message: "Video disappeared immediately after a successful update call",
              details: { videoId: args.videoId },
            });
          }
          return toSnapshot(args.videoId, verifiedContext);
        },
      });

      return { before, after };
    },
  };
}
