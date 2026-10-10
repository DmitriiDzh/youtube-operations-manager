import { z } from "zod";
import { DomainError, parseWithSchema } from "@/lib/shared-domain";
import { nextYoutubeQuotaReset } from "@/lib/youtube-quota";

/**
 * BL-171 (FO-REQ-0015 item 7, docs/roadmap/plans/VIDEO_COMMENTS_PLAN.md): the newest top-level comments of our own videos, stored so an
 * agent reads them locally. Only videos that have comments are read: once per Pacific day per channel the fresh comment counts are read
 * (1 unit per 50 videos) and decide which videos are due. Kept at most 30 days (III.E.4.c, the retention job); no author data.
 *
 * Its own feature module (AGENTS.md §M): Data API reads through the read gateway, the shared read-failure rules, its own tables.
 */

export const MAX_COMMENT_READS_PER_RUN = 50;
export const COMMENT_REREAD_DAYS = 7;
export const MAX_COMMENT_ATTEMPTS = 3;
/** A retry is due from the start of the next Pacific day (a run happens once a day; DST-safe -- review of BL-171). */
export const commentRetryAt = (failedAt: Date): Date => nextYoutubeQuotaReset(failedAt);

export type OwnVideo = { videoId: string; title: string; privacyStatus: string | null };
export type CommentState = {
  videoId: string;
  readAt: Date | null;
  readCommentCount: number | null;
  status: "collected" | "disabled" | "retry" | "failed";
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
};
export type StoredComment = {
  commentId: string;
  videoId: string;
  text: string;
  likeCount: number | null;
  publishedAt: string | null;
  updatedAt: string | null;
  replyCount: number | null;
  byChannelOwner: boolean;
};
type ReadComment = Omit<StoredComment, "videoId">;

function shiftIsoDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The videos to read now, at most `max`: never read first, then least recently read; within that batch those whose last attempt failed
 * last (the BL-168 queue). Private videos are never read. Due, by the last status: never read -- a count above 0; `collected` / `retry`
 * -- the count changed since the read, or the read is `COMMENT_REREAD_DAYS` or more days old while it still has comments (Pacific dates;
 * keeps every stored text younger than 30 days); `disabled` / `failed` -- only when the count changed. A `retry` waits for the Pacific day
 * of its time.
 */
export function planDueCommentReads(
  videos: OwnVideo[],
  counts: Map<string, number | null>,
  states: CommentState[],
  today: string,
  now: Date,
  toPacificDate: (at: Date) => string,
  max: number = MAX_COMMENT_READS_PER_RUN
): Array<{ videoId: string; count: number | null }> {
  const stateOf = new Map(states.map((state) => [state.videoId, state]));
  const due: Array<{ videoId: string; count: number | null; lastAt: number; retry: boolean }> = [];
  for (const video of videos) {
    if (video.privacyStatus === "private" || !counts.has(video.videoId)) continue;
    const count = counts.get(video.videoId) ?? null;
    const state = stateOf.get(video.videoId);
    let isDue: boolean;
    if (!state) {
      isDue = count !== null && count > 0;
    } else {
      // A retry is due from the Pacific day of its time on: a run happens once a day, so comparing the hour would push it a day further
      // (review of BL-171).
      if (state.status === "retry" && state.nextAttemptAt && toPacificDate(state.nextAttemptAt) > today) continue;
      const changed = count !== state.readCommentCount;
      if (state.status === "disabled" || state.status === "failed") {
        isDue = changed;
      } else {
        const stale = state.readAt === null || today >= shiftIsoDate(toPacificDate(state.readAt), COMMENT_REREAD_DAYS);
        // Never read yet (a first try failed) and nothing to read: nothing due. The weekly reread only refreshes stored text, so a video
        // with no comments left is not reread every week (review of BL-171).
        const hasComments = count !== null && count > 0;
        isDue = state.readAt === null ? hasComments || changed : changed || (stale && hasComments);
      }
    }
    if (isDue) due.push({ videoId: video.videoId, count, lastAt: state?.readAt?.getTime() ?? Number.NEGATIVE_INFINITY, retry: state?.status === "retry" });
  }
  due.sort((a, b) => a.lastAt - b.lastAt || a.videoId.localeCompare(b.videoId));
  const batch = due.slice(0, max);
  return [...batch.filter((item) => !item.retry), ...batch.filter((item) => item.retry)].map(({ videoId, count }) => ({ videoId, count }));
}

export type VideoCommentDependencies = {
  clock: { now(): Date };
  toPacificDate(at: Date): string;
  channelAccess: { assertActiveChannel(args: { userId: string | null | undefined; channelId: string }): Promise<string> };
  /** The channel's synced videos (any visibility; private ones are left out here). */
  listVideos(channelId: string): Promise<OwnVideo[]>;
  /** Reads through the read gateway, as the channel's signed-in user. */
  youtube: {
    commentCounts(credentialRef: { userId: string }, videoIds: string[]): Promise<Array<{ videoId: string; commentCount: number | null }>>;
    /** `channelId` is the video's channel: a comment it wrote is marked `byChannelOwner`. */
    comments(credentialRef: { userId: string }, videoId: string, channelId: string): Promise<ReadComment[]>;
  };
  failureKind(error: unknown): "stop" | "defer" | "attempt";
  store: {
    checkedOn(channelId: string): Promise<string | null>;
    markChecked(channelId: string, checkedOn: string, at: Date): Promise<void>;
    listStates(channelId: string): Promise<CommentState[]>;
    saveRead(row: { channelId: string; videoId: string; status: "collected" | "disabled"; readCommentCount: number | null; comments: ReadComment[]; at: Date }): Promise<void>;
    recordFailure(row: { channelId: string; videoId: string; count: number | null; error: string; at: Date; retryAt: Date; countsAsAttempt: boolean; maxAttempts: number }): Promise<"retry" | "failed">;
    listComments(channelId: string, videoIds: string[]): Promise<StoredComment[]>;
  };
};

const credentialRefSchema = z.object({ userId: z.string().min(1) }).strict();
export const collectDueCommentsInputSchema = z.object({ credentialRef: credentialRefSchema, channelId: z.string().min(1) }).strict();
export const listStoredCommentsInputSchema = z
  .object({
    channelId: z.string().min(1),
    credentialRef: credentialRefSchema.optional(),
    videoIds: z.array(z.string().min(1)).min(1).max(20),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export type StoredVideoComments = {
  videoId: string;
  title: string;
  /** The comment count the video had at its last read; null when never read or YouTube gave none. */
  commentCountAtRead: number | null;
  status: "collected" | "disabled" | "retry" | "failed" | "not_collected";
  /** When the stored text was fetched; rows older than 30 days are gone. */
  readAt: string | null;
  lastError: string | null;
  comments: Array<Omit<StoredComment, "videoId">>;
};

/** A 403 `commentsDisabled`: not a failure, the video simply takes no comments. */
function isCommentsDisabled(error: unknown): boolean {
  const response = typeof error === "object" && error !== null ? (error as { response?: { status?: unknown; data?: { error?: { errors?: unknown } } } }).response : undefined;
  const errors = Array.isArray(response?.data?.error?.errors) ? (response.data.error.errors as Array<{ reason?: unknown }>) : [];
  return response?.status === 403 && errors.some((entry) => entry?.reason === "commentsDisabled");
}

function userIdOf(credentialRef: unknown): string | null {
  return credentialRef && typeof credentialRef === "object" && typeof (credentialRef as { userId?: unknown }).userId === "string"
    ? (credentialRef as { userId: string }).userId
    : null;
}

export function createVideoCommentServices(deps: VideoCommentDependencies) {
  return {
    /**
     * Once per Pacific day per channel: the fresh counts, then the due videos' comments. `stop` (reads off, quota, sign-in) ends the run
     * with nothing written; `defer` (no answer, 429, 5xx) puts that video back a day and ends the run; `attempt` counts one of its 3
     * attempts. The day is marked checked only when the run got through, so an interrupted one is tried again on the next open.
     */
    async collectDueComments(input: unknown): Promise<{ checked: boolean; read: number; disabled: number; failed: number }> {
      const parsed = parseWithSchema(collectDueCommentsInputSchema, input, "collect due comments input");
      await deps.channelAccess.assertActiveChannel({ userId: parsed.credentialRef.userId, channelId: parsed.channelId });
      const now = deps.clock.now();
      const today = deps.toPacificDate(now);
      if ((await deps.store.checkedOn(parsed.channelId)) === today) return { checked: false, read: 0, disabled: 0, failed: 0 };
      const videos = (await deps.listVideos(parsed.channelId)).filter((video) => video.privacyStatus !== "private");
      const counts = new Map(
        (videos.length > 0 ? await deps.youtube.commentCounts(parsed.credentialRef, videos.map((video) => video.videoId)) : []).map((entry) => [entry.videoId, entry.commentCount])
      );
      const plan = planDueCommentReads(videos, counts, await deps.store.listStates(parsed.channelId), today, now, deps.toPacificDate);
      let read = 0;
      let disabled = 0;
      let failed = 0;
      for (const item of plan) {
        try {
          const comments = await deps.youtube.comments(parsed.credentialRef, item.videoId, parsed.channelId);
          await deps.store.saveRead({ channelId: parsed.channelId, videoId: item.videoId, status: "collected", readCommentCount: item.count, comments, at: deps.clock.now() });
          read += 1;
        } catch (error) {
          if (isCommentsDisabled(error)) {
            await deps.store.saveRead({ channelId: parsed.channelId, videoId: item.videoId, status: "disabled", readCommentCount: item.count, comments: [], at: deps.clock.now() });
            disabled += 1;
            continue;
          }
          const kind = deps.failureKind(error);
          if (kind === "stop") throw error;
          const at = deps.clock.now();
          const failure = {
            channelId: parsed.channelId,
            videoId: item.videoId,
            count: item.count,
            error: error instanceof Error ? error.message : String(error),
            at,
            retryAt: commentRetryAt(at),
            maxAttempts: MAX_COMMENT_ATTEMPTS,
          };
          if (kind === "defer") {
            await deps.store.recordFailure({ ...failure, countsAsAttempt: false });
            throw error;
          }
          await deps.store.recordFailure({ ...failure, countsAsAttempt: true });
          failed += 1;
        }
      }
      await deps.store.markChecked(parsed.channelId, today, deps.clock.now());
      return { checked: true, read, disabled, failed };
    },

    /** The stored comments of the session channel's videos, newest first. Local only; a video of another channel is not listed. */
    async listStoredComments(input: unknown): Promise<{ channelId: string; videos: StoredVideoComments[] }> {
      const parsed = parseWithSchema(listStoredCommentsInputSchema, input, "list stored comments input");
      await deps.channelAccess.assertActiveChannel({ userId: userIdOf(parsed.credentialRef), channelId: parsed.channelId });
      const limit = parsed.limit ?? 20;
      const wanted = new Set(parsed.videoIds);
      const videos = (await deps.listVideos(parsed.channelId)).filter((video) => wanted.has(video.videoId));
      const [states, comments] = await Promise.all([deps.store.listStates(parsed.channelId), deps.store.listComments(parsed.channelId, videos.map((video) => video.videoId))]);
      const stateOf = new Map(states.map((state) => [state.videoId, state]));
      return {
        channelId: parsed.channelId,
        videos: videos.map((video) => {
          const state = stateOf.get(video.videoId);
          return {
            videoId: video.videoId,
            title: video.title,
            commentCountAtRead: state?.readCommentCount ?? null,
            status: state ? state.status : "not_collected",
            readAt: state?.readAt ? state.readAt.toISOString() : null,
            lastError: state?.lastError ?? null,
            comments: comments
              .filter((comment) => comment.videoId === video.videoId)
              .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || a.commentId.localeCompare(b.commentId))
              .slice(0, limit)
              .map((comment) => ({
                commentId: comment.commentId,
                text: comment.text,
                likeCount: comment.likeCount,
                publishedAt: comment.publishedAt,
                updatedAt: comment.updatedAt,
                replyCount: comment.replyCount,
                byChannelOwner: comment.byChannelOwner,
              })),
          };
        }),
      };
    },
  };
}

export type VideoCommentServices = ReturnType<typeof createVideoCommentServices>;

/** AC-VC-08: while less than the configured reserve of the Data API quota is left, nothing is read. */
export function gateCommentCollection(
  guard: { isBackgroundReadAllowed(service: "data"): Promise<boolean> },
  collect: VideoCommentServices["collectDueComments"]
): VideoCommentServices["collectDueComments"] {
  return async (input) => ((await guard.isBackgroundReadAllowed("data")) ? collect(input) : { checked: false, read: 0, disabled: 0, failed: 0 });
}
export { DomainError };
