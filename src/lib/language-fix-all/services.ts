import { z } from "zod";
import { DomainError, type OperationHandle, type OperationRegistry } from "./contracts";

/**
 * Server-side "Fix all" for the channel language baseline (owner instruction, 2026-10-03: move it
 * off the browser so a reload cannot kill the run, and report progress/cancel through the shared
 * operation registry, ADR 0015).
 *
 * This module is ORCHESTRATION ONLY. It never talks to YouTube: every write goes through the
 * injected `applyFieldsUpdate`, which is `video-details`' own service -- identity check, backup,
 * etag conflict check, audit, read-back verification, Live Writes barrier, and finally
 * `src/lib/youtube-write-gateway/` (AGENTS.md §G, ADR 0005). There is no second write path here.
 */

const MAX_VIDEOS = 500;

const startInputSchema = z
  .object({
    channelId: z.string().min(1),
    userId: z.string().min(1),
    /** The channel baseline the operator previewed against. The write is refused if it has changed
     * since, so the server never writes a value the operator did not see (approval integrity). */
    baseline: z
      .object({ defaultLanguage: z.string().nullable(), defaultAudioLanguage: z.string().nullable() })
      .strict(),
    videos: z
      .array(z.object({ videoId: z.string().min(1), expectedEtag: z.string().min(1).optional() }).strict())
      .min(1)
      .max(MAX_VIDEOS),
  })
  .strict();

type LanguagePatch = { defaultLanguage?: string; defaultAudioLanguage?: string };

export type FixAllDependencies = {
  getDeviations(input: { channelId: string }): Promise<{
    defaults: { defaultLanguage: string | null; defaultAudioLanguage: string | null };
    deviations: Array<{
      videoId: string;
      title: string;
      defaultLanguageDeviates: boolean;
      defaultAudioLanguageDeviates: boolean;
    }>;
  }>;
  applyFieldsUpdate(input: {
    credentialRef: { userId: string };
    expectedChannelId: string;
    videoId: string;
    patch: LanguagePatch;
    expectedEtag?: string;
  }): Promise<{ verified: boolean }>;
  registry: OperationRegistry;
  /** The same device-availability gate `src/proxy.ts` applies to a mutating request. The proxy sees
   * only the START request; this is called before EVERY video so an export/import or an unavailable
   * device appearing mid-run stops the remaining writes. Throws to refuse. */
  assertMutationAllowed(): Promise<void>;
};

export const FIX_ALL_OPERATION_KIND = "language-fix-all";

type PlannedVideo = { videoId: string; label: string; patch: LanguagePatch; expectedEtag?: string };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Apply failed";
}

export function createLanguageFixAllServices(deps: FixAllDependencies) {
  return {
    /**
     * Validates, plans and registers the run, then returns a `run` function the caller schedules
     * (the route uses `after()`). Planning is done HERE, on the server, from the channel baseline and
     * the synced videos -- the caller only says which videos (and which etag it previewed); it can
     * never choose which fields or values are written.
     * Throws `OperationAlreadyRunningError` if a Fix all is already running for the channel.
     */
    async start(rawInput: unknown): Promise<{ operationId: string; run: () => Promise<void> }> {
      const parsed = startInputSchema.safeParse(rawInput);
      if (!parsed.success) {
        throw new DomainError({
          code: "validation_failed",
          message: `Invalid Fix all request: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
        });
      }
      const input = parsed.data;

      const report = await deps.getDeviations({ channelId: input.channelId });
      const { defaultLanguage, defaultAudioLanguage } = report.defaults;
      if (defaultLanguage !== input.baseline.defaultLanguage || defaultAudioLanguage !== input.baseline.defaultAudioLanguage) {
        throw new DomainError({
          code: "video_details_conflict",
          message: "The channel language baseline changed since you ran the check -- re-run the check before writing",
          details: { previewed: input.baseline, current: report.defaults },
        });
      }
      if (!defaultLanguage && !defaultAudioLanguage) {
        throw new DomainError({
          code: "validation_failed",
          message: "This channel has no language baseline set -- save channel defaults first",
        });
      }

      const deviating = new Map(report.deviations.map((row) => [row.videoId, row]));
      const seen = new Set<string>();
      const planned: PlannedVideo[] = [];
      const skipped: Array<{ videoId: string; reason: string }> = [];

      for (const requested of input.videos) {
        if (seen.has(requested.videoId)) continue;
        seen.add(requested.videoId);
        const row = deviating.get(requested.videoId);
        // Not in this channel's deviation report: either not this channel's video or already in
        // sync. Never sent either way.
        if (!row) {
          skipped.push({ videoId: requested.videoId, reason: "Already matches the baseline or is not a video of this channel" });
          continue;
        }
        const patch: LanguagePatch = {
          ...(row.defaultLanguageDeviates && defaultLanguage ? { defaultLanguage } : {}),
          ...(row.defaultAudioLanguageDeviates && defaultAudioLanguage ? { defaultAudioLanguage } : {}),
        };
        if (Object.keys(patch).length === 0) {
          skipped.push({ videoId: requested.videoId, reason: "Nothing to change" });
          continue;
        }
        planned.push({ videoId: requested.videoId, label: row.title, patch, expectedEtag: requested.expectedEtag });
      }

      if (planned.length === 0) {
        throw new DomainError({ code: "validation_failed", message: "None of the requested videos needs a language change" });
      }

      const handle = deps.registry.start({
        kind: FIX_ALL_OPERATION_KIND,
        channelId: input.channelId,
        title: "Writing language labels to YouTube",
        cancellable: true,
        items: [
          ...planned.map((video) => ({ id: video.videoId, label: video.label })),
          ...skipped.map((video) => ({ id: video.videoId, label: video.videoId })),
        ],
      });
      for (const video of skipped) handle.setItem(video.videoId, "skipped", video.reason);

      return {
        operationId: handle.id,
        run: () => runPlan({ deps, handle, planned, channelId: input.channelId, userId: input.userId }),
      };
    },
  };
}

/** Sequential and fail-fast: the first failure stops the run, so a systemic problem (Live Writes off,
 * wrong channel, quota) is reported once. Cancel is honoured BEFORE each video; a write already
 * sent is never abandoned. Never throws -- every outcome ends in `handle.finish`. */
async function runPlan(args: {
  deps: FixAllDependencies;
  handle: OperationHandle;
  planned: PlannedVideo[];
  channelId: string;
  userId: string;
}): Promise<void> {
  const { deps, handle, planned, channelId, userId } = args;
  let written = 0;
  let stopMessage: string | null = null;
  let failed = false;

  handle.setStage("Writing language labels — each video is backed up and verified");
  try {
    for (const video of planned) {
      if (stopMessage) {
        handle.setItem(video.videoId, "skipped");
        continue;
      }
      if (handle.isCancelRequested()) {
        stopMessage = "Cancelled — the remaining videos were not written.";
        handle.setItem(video.videoId, "skipped");
        continue;
      }
      handle.touch();
      try {
        await deps.assertMutationAllowed();
        handle.setItem(video.videoId, "running");
        const result = await deps.applyFieldsUpdate({
          credentialRef: { userId },
          expectedChannelId: channelId,
          videoId: video.videoId,
          patch: video.patch,
          ...(video.expectedEtag ? { expectedEtag: video.expectedEtag } : {}),
        });
        if (result.verified === false) throw new Error("Written, but the read-back did not match");
        handle.setItem(video.videoId, "done");
        written += 1;
      } catch (error) {
        const message = describeError(error);
        handle.setItem(video.videoId, "failed", message);
        stopMessage = `Stopped at the first error: ${message}`;
        failed = true;
      }
    }
  } catch (error) {
    stopMessage = `Unexpected error: ${describeError(error)}`;
    failed = true;
  }
  handle.finish({
    error: failed,
    message: stopMessage ?? `${written} video${written === 1 ? "" : "s"} written and verified.`,
  });
}
