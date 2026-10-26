// BL-227 (docs/roadmap/plans/LANGUAGES_REVIEW_PLAN.md, ADR 0052): translation review by video -- agents' check reports and the
// review read model. A feature module (AGENTS.md §M): it reads change sets through `changesets`, the send's "already written" rule
// through `batches`, the change-drafts document through `sync-gateway`, and checks through `shared-localization-checks`; nothing
// else depends on it except the Web routes and the factory tools. It approves, rejects and sends nothing itself.
import { createChangeSetCore, readWithChannelBaseline } from "@/lib/changesets";
import { createSendApprovedCore } from "@/lib/batches";
import { createChangeDraftsCoreForProduction, checkReportEntries, latestCheckReport, type DraftTranslationRequest } from "@/lib/sync-gateway";
import { createChannelVideoStoreAdapter } from "@/lib/channel-video-store";
import { getChannelExpectedLanguages, getChannelTargetLanguages, listPublishingUploads } from "@/lib/db";
import { originalFingerprint } from "@/lib/shared-localization-checks/fingerprint";
import { createDefaultLogger } from "@/lib/shared-logger";
import { randomUUID } from "node:crypto";
import { DomainError } from "@/lib/shared-domain";
import { reportChecks } from "./report";
import { completeRequestInputSchema, createRequestInputSchema, failRequestInputSchema, listRequestsInputSchema, parseOrRefuse, requestRefInputSchema, toRequestView, type TranslationRequestView } from "./requests";
import { buildVideoReview, needsReview, type ReviewChange, type ReviewSetInput, type VideoReview } from "./review";

export { reportChecksInputSchema, type ReportChecksInput } from "./report";
export type { VideoReview, ReviewLanguage, ReviewRow, ReviewVerdict } from "./review";
export type { TranslationRequestView } from "./requests";

/** An agent's check report on a change set of `channelId` (the set must be that channel's: `not_found` otherwise). */
export async function reportLocalizationChecks(input: unknown, by: "factory" | "worker") {
  const drafts = createChangeDraftsCoreForProduction();
  return reportChecks({ addCheckReport: (report) => drafts.addCheckReport(report) }, input, by);
}

const PAGE = 500;

function parseJsonRecord(text: string | undefined): Record<string, string> {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Every review of the channel's videos that have changes not rejected and not written yet, newest set first. */
async function loadReviews(channelId: string, onlyVideoId?: string): Promise<VideoReview[]> {
  const changeSets = createChangeSetCore();
  const sets = (await changeSets.listChangeSets({ channelId })).filter((set) => set.pendingCount > 0 || set.approvedCount > 0);
  if (sets.length === 0) return [];
  const written = await createSendApprovedCore().writtenChangeIds(channelId, sets.map((set) => set.id));

  // Each set's changes (revalidated by getChangeSet, as the review panel does), only of the one video when asked.
  const setInputs: Array<ReviewSetInput & { videoIds: Set<string> }> = [];
  let document: Awaited<ReturnType<ReturnType<typeof createChangeDraftsCoreForProduction>["getDocument"]>> | null = null;
  try {
    document = await createChangeDraftsCoreForProduction().getDocument({ channelId });
  } catch {
    document = null;
  }
  for (const set of sets) {
    const changes: ReviewChange[] = [];
    try {
      for (let page = 1; ; page++) {
        const result = await changeSets.getChangeSet({ channelId, changeSetId: set.id, page, pageSize: PAGE, ...(onlyVideoId ? { videoId: onlyVideoId } : {}) });
        changes.push(...(result.changes as ReviewChange[]));
        if (page * PAGE >= result.pagination.total) break;
      }
    } catch (error) {
      // One unreadable set (e.g. a projection row its document no longer has) must not hide every other video's review.
      createDefaultLogger().error({ event: "localization_review.set_unreadable", context: { channelId, changeSetId: set.id, error: error instanceof Error ? error.message : String(error) } });
      continue;
    }
    const open = changes.filter((change) => change.approvalStatus !== "rejected" && !written.has(change.id));
    if (open.length === 0) continue;
    const details = document?.setDetails?.[set.id];
    const report = document ? latestCheckReport(document, set.id) : null;
    setInputs.push({
      changeSet: { id: set.id, source: set.source, createdAt: set.createdAt },
      changes,
      details: details ? { createdBy: details.createdBy, notes: parseJsonRecord(details.notesJson), originals: parseJsonRecord(details.originalsJson) } : null,
      report: report ? { id: report.id, reportedAt: report.reportedAt, reportedBy: report.reportedBy, entries: checkReportEntries(report) } : null,
      videoIds: new Set(open.map((change) => change.videoId)),
    });
  }

  const videoIds = new Set(setInputs.flatMap((set) => [...set.videoIds]));
  if (videoIds.size === 0) return [];
  const baseline = (await getChannelExpectedLanguages(channelId)).defaultLanguage;
  const videos = new Map((await createChannelVideoStoreAdapter().listVideosByChannel(channelId)).map((video) => [video.videoId, video]));
  // The channel's languages as the Languages table shows them: the tracked ones and every language its videos already have.
  const tracked = [...new Set([...(await getChannelTargetLanguages(channelId)), ...[...videos.values()].flatMap((video) => Object.keys(video.existingLocalizations ?? {}))])];
  const uploads = new Map<string, { video: string | null; slotId: string | null; publishAt: string | null }>();
  for (const upload of await listPublishingUploads({ channelId, limit: 500 })) {
    if (upload.videoId && !uploads.has(upload.videoId)) uploads.set(upload.videoId, { video: upload.video, slotId: upload.slotId ?? null, publishAt: upload.publishAt ?? null });
  }

  const reviews: VideoReview[] = [];
  for (const videoId of videoIds) {
    const video = videos.get(videoId);
    if (!video) continue;
    const read = readWithChannelBaseline(video, baseline);
    const review = buildVideoReview({
      video: {
        videoId,
        title: video.title,
        description: video.description,
        defaultLanguage: video.defaultLanguage,
        thumbnailUrl: video.thumbnails?.medium?.url ?? video.thumbnails?.default?.url ?? null,
        publishedAt: video.publishedAt ?? null,
        privacyStatus: video.privacyStatus ?? null,
      },
      ownLanguage: read.alignedTo ?? video.defaultLanguage ?? baseline,
      trackedLanguages: tracked,
      currentTitle: (language) => read.current(language, "title"),
      currentFingerprint: originalFingerprint(video.title, video.description),
      sets: setInputs.filter((set) => set.videoIds.has(videoId)),
      writtenChangeIds: written,
      upload: uploads.get(videoId) ?? null,
    });
    if (needsReview(review)) reviews.push(review);
  }
  return reviews;
}

export type ReviewQueueEntry = Pick<VideoReview, "video" | "upload" | "counts"> & { languages: number };

/** The review queue: one entry per video waiting for the owner, newest release date first. */
export async function listLocalizationReviewQueue(channelId: string): Promise<ReviewQueueEntry[]> {
  const reviews = await loadReviews(channelId);
  return reviews
    .map((review) => ({ video: review.video, upload: review.upload, counts: review.counts, languages: review.languages.length }))
    .sort((a, b) => (b.video.publishedAt ?? "").localeCompare(a.video.publishedAt ?? ""));
}

/** One video's review, or null when nothing of it waits for the owner. */
export async function getLocalizationReview(channelId: string, videoId: string): Promise<VideoReview | null> {
  return (await loadReviews(channelId, videoId)).find((review) => review.video.videoId === videoId) ?? null;
}

// -- BL-227 stage 2 (LANGUAGES_REVIEW_PLAN.md §7a): translation requests. The owner creates and cancels (Web); an agent lists, claims,
// completes and fails (MCP). Nothing here approves, rejects or sends.

/** The owner's request: every video must be one of the channel's synced videos. */
export async function createTranslationRequest(channelId: string, input: unknown): Promise<TranslationRequestView> {
  const parsed = parseOrRefuse(createRequestInputSchema, input, "translation request");
  const videos = new Map((await createChannelVideoStoreAdapter().listVideosByChannel(channelId)).map((video) => [video.videoId, video]));
  const unknown = parsed.videoIds.filter((videoId) => !videos.has(videoId));
  if (unknown.length > 0) {
    throw new DomainError({ code: "not_found", message: "A requested video is not one of this channel's synced videos", details: { videoIds: unknown } });
  }
  const originals = Object.fromEntries(parsed.videoIds.map((videoId) => [videoId, originalFingerprint(videos.get(videoId)!.title, videos.get(videoId)!.description)]));
  const stored = await createChangeDraftsCoreForProduction().createTranslationRequest({
    channelId,
    id: randomUUID(),
    videoIds: parsed.videoIds,
    languages: parsed.languages,
    mode: parsed.mode,
    fields: parsed.fields,
    note: parsed.note && parsed.note.length > 0 ? parsed.note : null,
    redoOfChangeId: parsed.redoOfChangeId ?? null,
    originals,
  });
  return toRequestView(stored, Date.now());
}

/** A channel's requests, newest first (optionally one status). A channel with no document yet has none. */
export async function listTranslationRequests(input: unknown): Promise<{ requests: TranslationRequestView[] }> {
  const parsed = parseOrRefuse(listRequestsInputSchema, input, "list input");
  let document: { translationRequests?: Record<string, DraftTranslationRequest> } | null = null;
  try {
    document = await createChangeDraftsCoreForProduction().getDocument({ channelId: parsed.channelId });
  } catch {
    document = null;
  }
  const now = Date.now();
  const requests = Object.values(document?.translationRequests ?? {})
    .filter((request) => !parsed.status || request.status === parsed.status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((request) => toRequestView(request, now));
  return { requests };
}

export async function cancelTranslationRequest(channelId: string, requestId: string): Promise<TranslationRequestView> {
  const ref = parseOrRefuse(requestRefInputSchema, { channelId, requestId }, "request");
  return toRequestView(await createChangeDraftsCoreForProduction().cancelTranslationRequest(ref), Date.now());
}

export async function claimTranslationRequest(input: unknown, by: "factory" | "worker"): Promise<{ request: TranslationRequestView }> {
  const ref = parseOrRefuse(requestRefInputSchema, input, "claim input");
  return { request: toRequestView(await createChangeDraftsCoreForProduction().claimTranslationRequest({ ...ref, by }), Date.now()) };
}

export async function completeTranslationRequest(input: unknown, by: "factory" | "worker"): Promise<{ request: TranslationRequestView }> {
  const parsed = parseOrRefuse(completeRequestInputSchema, input, "complete input");
  return { request: toRequestView(await createChangeDraftsCoreForProduction().completeTranslationRequest({ ...parsed, by }), Date.now()) };
}

export async function failTranslationRequest(input: unknown, by: "factory" | "worker"): Promise<{ request: TranslationRequestView }> {
  const parsed = parseOrRefuse(failRequestInputSchema, input, "fail input");
  return { request: toRequestView(await createChangeDraftsCoreForProduction().failTranslationRequest({ ...parsed, by }), Date.now()) };
}
