import { YOUTUBE_READ_SCOPE, YOUTUBE_WRITE_SCOPE } from "@/lib/auth";
import type { ResolvedCredentials } from "@/lib/video-metadata/contracts";
import {
  DomainError,
  isDomainError,
  type ApplyFieldsUpdateResult,
  type PreviewFieldsUpdateResult,
  type VideoDetailsDiff,
  type VideoDetailsPatch,
  type VideoDetailsSnapshot,
} from "./contracts";
import {
  applyFieldsUpdateInputSchema,
  getSnapshotInputSchema,
  parseWithSchema,
  previewFieldsUpdateInputSchema,
} from "./schemas";

type WriteChannelGuardrailOutput = {
  shouldPersistSelection: boolean;
  userId: string | null;
  expectedChannelId: string;
};

export type ServiceDependencies = {
  authResolver: {
    resolve(args: { credentialRef: unknown; requiredScopes: readonly string[] }): Promise<ResolvedCredentials>;
  };
  writeContext: {
    assertWriteChannel(args: {
      credentialRef: unknown;
      credentials: ResolvedCredentials;
      expectedChannelId?: string;
    }): Promise<WriteChannelGuardrailOutput>;
  };
  channelSelectionStore: {
    setSelectedChannelId(userId: string, channelId: string): Promise<void>;
  };
  youtubeApi: {
    getSnapshot(args: { credentials: ResolvedCredentials; videoId: string }): Promise<VideoDetailsSnapshot>;
    applyPatch(args: {
      credentials: ResolvedCredentials;
      videoId: string;
      patch: VideoDetailsPatch;
    }): Promise<{ before: VideoDetailsSnapshot; after: VideoDetailsSnapshot }>;
  };
  backup: {
    checkInfrastructureHealth(): Promise<{ healthy: boolean; error?: string }>;
    captureBackup(args: {
      channelId: string;
      operationId: string;
      videoId: string;
      snapshot: { kind: "video_fields"; snippet: Record<string, unknown>; status: Record<string, unknown>; recordingDate: string | null };
    }): Promise<{ path: string; capturedAt: string }>;
  };
  auditStore: {
    record(args: {
      channelId: string;
      videoId: string;
      eventType: "DRY_RUN" | "BACKUP" | "RESULT" | "VERIFICATION";
      detail: unknown;
    }): Promise<void>;
  };
  localCache: {
    /** Refreshes only the fields this module can touch that also happen to exist in the local
     * `videos` cache (title/description/privacyStatus/defaultLanguage/etag) -- reuses
     * `channel-sync`'s own `upsertVideos`, never a parallel write path (AGENTS.md §D). Fields
     * this module writes that the cache doesn't track at all (tags, categoryId, license,
     * publishAt, ...) are simply not part of the cache and need no handling here. */
    refreshVideoFields(args: { channelId: string; videoId: string; after: VideoDetailsSnapshot }): Promise<void>;
  };
  idGenerator: () => string;
};

function mapUnknownError(error: unknown, fallbackCode: DomainError["code"]) {
  if (isDomainError(error)) return error;
  return new DomainError({
    code: fallbackCode,
    message: error instanceof Error ? error.message : "Unknown error",
  });
}

function computeDiff(before: VideoDetailsSnapshot, patch: VideoDetailsPatch): VideoDetailsDiff[] {
  return (Object.keys(patch) as Array<keyof VideoDetailsPatch>).map((field) => ({
    field,
    before: before[field as keyof VideoDetailsSnapshot] ?? null,
    proposed: patch[field],
  }));
}

export function createVideoDetailsServices(deps: ServiceDependencies) {
  return {
    /** Pure read, no patch involved -- what a "Details" panel loads on open. No audit event: an
     * audit trail records what happened TO the video, and a view changes nothing. */
    async getSnapshot(input: unknown): Promise<VideoDetailsSnapshot> {
      const parsedInput = parseWithSchema(getSnapshotInputSchema, input, "get snapshot input");
      try {
        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_READ_SCOPE],
        });
        return await deps.youtubeApi.getSnapshot({ credentials, videoId: parsedInput.videoId });
      } catch (error) {
        throw mapUnknownError(error, "not_found");
      }
    },

    /** Read-only: fetches the current snapshot and computes the diff a patch would produce,
     * without ever calling `videos.update`. Only needs read scope -- no write-channel identity
     * risk exists here, since nothing is written (mirrors `video-metadata`'s own preview). */
    async previewFieldsUpdate(input: unknown): Promise<PreviewFieldsUpdateResult> {
      const parsedInput = parseWithSchema(previewFieldsUpdateInputSchema, input, "preview fields update input");

      try {
        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_READ_SCOPE],
        });

        const before = await deps.youtubeApi.getSnapshot({ credentials, videoId: parsedInput.videoId });

        if (parsedInput.patch.publishAt !== undefined && before.publishAt) {
          throw new DomainError({
            code: "publish_at_already_published",
            message: "publishAt can only be set on a video that has never been published",
            details: { videoId: parsedInput.videoId, currentPublishAt: before.publishAt },
          });
        }

        const diff = computeDiff(before, parsedInput.patch);

        await deps.auditStore.record({
          channelId: parsedInput.expectedChannelId,
          videoId: parsedInput.videoId,
          eventType: "DRY_RUN",
          detail: { patch: parsedInput.patch, diff },
        });

        return { dryRun: true, videoId: parsedInput.videoId, before, diff };
      } catch (error) {
        throw mapUnknownError(error, "update_failed");
      }
    },

    /**
     * The real, non-dry-run write path (AGENTS.md §G minimum: identity check, validation,
     * backup, diff [computed by `previewFieldsUpdate`, this is the "approval" step that follows
     * it], dry-run capability [the sibling method above], audit, verification [below]).
     */
    async applyFieldsUpdate(input: unknown): Promise<ApplyFieldsUpdateResult> {
      const parsedInput = parseWithSchema(applyFieldsUpdateInputSchema, input, "apply fields update input");

      try {
        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_WRITE_SCOPE],
        });

        // Identity check (AGENTS.md §G) -- fails closed on a wrong-channel condition, reusing
        // the one shared guardrail rather than a parallel one.
        const guardrail = await deps.writeContext.assertWriteChannel({
          credentialRef: parsedInput.credentialRef,
          credentials,
          expectedChannelId: parsedInput.expectedChannelId,
        });

        const backupHealth = await deps.backup.checkInfrastructureHealth();
        if (!backupHealth.healthy) {
          throw new DomainError({
            code: "backup_infrastructure_unavailable",
            message: backupHealth.error ?? "Backup storage is unreachable",
          });
        }

        const before = await deps.youtubeApi.getSnapshot({ credentials, videoId: parsedInput.videoId });

        // Conflict detection: if the caller tells us which etag its diff was shown against
        // (any UI built on top of previewFieldsUpdate should), and the video changed on YouTube
        // since then, fail closed rather than silently apply a patch the operator never actually
        // saw a correct diff for (AGENTS.md §G's "approval" means approving THIS diff).
        if (parsedInput.expectedEtag && before.etag !== parsedInput.expectedEtag) {
          throw new DomainError({
            code: "video_details_conflict",
            message: "The video changed on YouTube since this patch's diff was shown -- re-preview before saving",
            details: { videoId: parsedInput.videoId, expectedEtag: parsedInput.expectedEtag, actualEtag: before.etag },
          });
        }

        const backupRecord = await deps.backup.captureBackup({
          channelId: guardrail.expectedChannelId,
          operationId: deps.idGenerator(),
          videoId: parsedInput.videoId,
          snapshot: {
            kind: "video_fields",
            snippet: { title: before.title, description: before.description, tags: before.tags, categoryId: before.categoryId, defaultLanguage: before.defaultLanguage },
            status: {
              privacyStatus: before.privacyStatus,
              publishAt: before.publishAt,
              license: before.license,
              embeddable: before.embeddable,
              publicStatsViewable: before.publicStatsViewable,
              selfDeclaredMadeForKids: before.selfDeclaredMadeForKids,
              containsSyntheticMedia: before.containsSyntheticMedia,
            },
            recordingDate: before.recordingDate,
          },
        });

        await deps.auditStore.record({
          channelId: guardrail.expectedChannelId,
          videoId: parsedInput.videoId,
          eventType: "BACKUP",
          detail: { backupPath: backupRecord.path },
        });

        const { after } = await deps.youtubeApi.applyPatch({
          credentials,
          videoId: parsedInput.videoId,
          patch: parsedInput.patch,
        });

        if (guardrail.shouldPersistSelection && guardrail.userId) {
          await deps.channelSelectionStore.setSelectedChannelId(guardrail.userId, guardrail.expectedChannelId);
        }

        await deps.auditStore.record({
          channelId: guardrail.expectedChannelId,
          videoId: parsedInput.videoId,
          eventType: "RESULT",
          detail: { patch: parsedInput.patch },
        });

        // Verification (AGENTS.md §G): confirm every patched field actually reads back as sent,
        // never assumed from a 200 response alone.
        const verified = (Object.keys(parsedInput.patch) as Array<keyof VideoDetailsPatch>).every(
          (field) => after[field as keyof VideoDetailsSnapshot] === parsedInput.patch[field]
        );

        await deps.auditStore.record({
          channelId: guardrail.expectedChannelId,
          videoId: parsedInput.videoId,
          eventType: "VERIFICATION",
          detail: { verified },
        });

        if (!verified) {
          throw new DomainError({
            code: "update_failed",
            message: "Post-write verification found at least one field did not match what was sent",
            details: { videoId: parsedInput.videoId, patch: parsedInput.patch, after },
          });
        }

        // "не ломая синхронизацию" (owner, Telegram): refresh only the fields this module
        // touched that the local cache also tracks -- never advances `lastSyncedAt`, since that
        // field means "a full channel-level resync happened," which this targeted edit is not
        // (see docs/ROADMAP_STATUS.md's entry for this feature for the full reasoning).
        await deps.localCache.refreshVideoFields({
          channelId: guardrail.expectedChannelId,
          videoId: parsedInput.videoId,
          after,
        });

        return {
          dryRun: false,
          videoId: parsedInput.videoId,
          before,
          after,
          verified,
          backupPath: backupRecord.path,
        };
      } catch (error) {
        throw mapUnknownError(error, "update_failed");
      }
    },
  };
}

export type VideoDetailsServices = ReturnType<typeof createVideoDetailsServices>;
