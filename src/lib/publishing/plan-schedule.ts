// BL-225 stage 3 (WEEKLY_PUBLISHING_PLAN.md stage 3; ADR 0051 §5, §7, §10; FO-REQ-0040 item 5; owner msg 3537): the weekly plan's
// word on a video this computer already uploaded for a slot. A veto removes its date (the video stays private); an approval -- of a
// slot whose package uploaded before it was approved, or a re-approval with a new time -- sets the slot's time. Only on a finished
// upload whose checks passed (translations, thumbnail, playlist, read-back): a withheld date stays withheld. A slot that is not
// approved now (pending) is left as it is: only a veto stops a release. Each change goes through video-details' own write path
// (identity, backup, Live writes right before the write, read-back) and is read back again here before it is recorded.

import type { StoredPublishingUpload } from "@/lib/db";
import { approvalNamesUpload, type SlotDecision } from "./slot-decision";
import type { UploadSteps } from "./upload-runner";

/** video-details' rule: a date within 15 minutes is neither written nor removed (the video could publish meanwhile). */
const MARGIN_MS = 15 * 60_000;
/** A refused or mismatched change is tried again after this long. */
export const RETRY_AFTER_MS = 60 * 60_000;

export type PlanScheduleDeps = {
  /** This computer's finished uploads that name a plan slot and have a video. */
  rows(): Promise<StoredPublishingUpload[]>;
  slotDecisions(channelId: string): Promise<Map<string, SlotDecision>>;
  /**
   * BL-243 (ADR 0063 §4): the channel's videos the sync found removed on YouTube. Only DATING consults it: a removed video is never
   * given a date, and when this read fails no video of the channel is dated that pass (fail closed). Removing a date (a veto) never
   * waits on it -- that goes to YouTube's own answer (`read`); a "no such video" answer ends the change only when this list (a
   * completed owner removed-check) names the video too. Absent: none known.
   */
  removedVideoIds?(channelId: string): Promise<ReadonlySet<string>>;
  /**
   * The video's privacy and date as YouTube has them now (read gateway, with the row's account). BL-243: `missing` -- YouTube
   * answered "no such video". Not proof on its own (another account, a partial answer): it ends a change only with the removed mark.
   */
  read(row: StoredPublishingUpload): Promise<{ privacyStatus: string | null; publishAt: string | null; missing?: boolean }>;
  /** video-details' write: private, with this date or (null) none; the AI flag sent again (YouTube does not return it). */
  write(row: StoredPublishingUpload, publishAt: string | null): Promise<void>;
  /** Stores the row's new date and steps (only while the row is still `done`). */
  update(row: StoredPublishingUpload, set: { publishAt: string | null; stepsJson: string }): Promise<boolean>;
  audit(row: StoredPublishingUpload, detail: Record<string, unknown>): Promise<void>;
  clock: { now(): Date };
  /** Review #4: the switches, read at the start of every pass -- off, the pass makes no YouTube call. */
  liveWritesEnabled(): Promise<boolean>;
  dataReadsEnabled(): Promise<boolean>;
  /** The next YouTube quota day (midnight Pacific): after a quota refusal nothing is read before it. */
  nextQuotaReset(now: Date): Date;
};

const stepsOf = (row: Pick<StoredPublishingUpload, "stepsJson">): UploadSteps => {
  try {
    return JSON.parse(row.stepsJson) as UploadSteps;
  } catch {
    return {};
  }
};

const sameInstant = (a: string | null, b: string | null) => (a === null || b === null ? a === b : Date.parse(a) === Date.parse(b));

/** The upload's own checks passed, so the plan may give the video a date (the runner's rule for the date step). */
export function checksPassed(steps: UploadSteps): boolean {
  const translations = steps.localizations === undefined || steps.localizations === "none" || steps.localizations === "verified";
  return translations && steps.thumbnail === "set" && steps.playlist !== "failed" && steps.verify?.result === "verified";
}

/**
 * BL-242 (ADR 0062 §3-§4): the plan's decision on a finished upload. A slot whose approval names the row's video id takes it,
 * whatever slot the row was made for (a slot took the uploaded video by its package); two such approved slots: nothing (pending).
 * With no approval naming it, a veto standing on an approval of that video id removes its date. Otherwise the row's own slot
 * decides -- an approval naming a package (`packaged` stage) only when it names this upload: its video id, or (none named) its
 * manifest. Pure.
 */
export function decisionForRow(row: Pick<StoredPublishingUpload, "slotId" | "videoId" | "manifestSha256">, decisions: ReadonlyMap<string, SlotDecision>): SlotDecision | undefined {
  if (row.videoId) {
    const naming = [...decisions.values()].filter((d) => d.kind !== "pending" && d.package?.videoId === row.videoId);
    const approved = naming.filter((d) => d.kind === "approved");
    if (approved.length > 1) return { kind: "pending" };
    if (approved.length === 1) return approved[0];
    if (naming.length > 0) return { kind: "vetoed" };
  }
  const own = row.slotId ? decisions.get(row.slotId) : undefined;
  if (own?.kind === "approved" && !approvalNamesUpload(own, { manifestSha256: row.manifestSha256, videoId: row.videoId })) return { kind: "pending" };
  return own;
}

/**
 * BL-243: video-details' definite "no such video" for this video -- videos.list returned no item for the id (`reason: "no_item"`).
 * An item without snippet/status (`partial`) or a mapped unknown error is not one: refused and retried.
 */
export function isVideoNotFound(error: unknown, videoId: string): boolean {
  const e = error as { code?: unknown; details?: { videoId?: unknown; reason?: unknown } } | null;
  return e?.code === "not_found" && e.details?.videoId === videoId && e.details?.reason === "no_item";
}

/** What the plan wants for the row's video now: a date, no date, or nothing (leave it). Pure. */
export function desiredDate(row: Pick<StoredPublishingUpload, "publishAt" | "stepsJson">, decision: SlotDecision | undefined, nowMs: number): { publishAt: string | null } | null {
  if (!decision || decision.kind === "pending") return null;
  const current = row.publishAt;
  // A date already within the margin (or past) is the release itself: nothing is changed any more.
  if (current !== null && Date.parse(current) <= nowMs + MARGIN_MS) return null;
  let want: { publishAt: string | null } | null;
  if (decision.kind === "vetoed") want = current === null ? null : { publishAt: null };
  else if (Date.parse(decision.publishAt) <= nowMs + MARGIN_MS || !checksPassed(stepsOf(row))) want = null;
  else want = sameInstant(current, decision.publishAt) ? null : { publishAt: new Date(decision.publishAt).toISOString() };
  // The same change that was refused or read back differently is tried again only an hour later (the slot shows it meanwhile):
  // never a write every pass.
  const last = stepsOf(row).planSync;
  if (want && last && last.result !== "verified" && sameInstant(last.publishAt, want.publishAt) && nowMs - Date.parse(last.at) < RETRY_AFTER_MS) return null;
  return want;
}

/** Errors after which the pass stops and tries again later (nothing recorded): the switches, the quota, an answer not given. */
const RETRY_LATER = new Set(["live_writes_disabled", "data_api_reads_disabled"]);
function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

export function createPlanSchedule(deps: PlanScheduleDeps) {
  /** Review #4: no YouTube call before this (a quota refusal waits for the quota day). */
  let quotaPausedUntil = 0;
  /** One change, read before and after: refused when the video is not private or its date is within the margin. */
  async function change(row: StoredPublishingUpload, publishAt: string | null, action: "scheduled" | "unscheduled", at: string): Promise<NonNullable<UploadSteps["planSync"]>> {
    const before = await deps.read(row);
    // BL-243: YouTube answered "no such video" -- the pass decides with the removed mark whether that is the end of it.
    if (before.missing) return { at, action, publishAt, result: "video_missing", reason: "the video is not on YouTube" };
    // Public or unlisted already (by the owner in Studio, or released): the plan never takes a video back.
    if (before.privacyStatus !== "private") return { at, action, publishAt, result: "refused", reason: `video is ${before.privacyStatus ?? "unknown"}` };
    if (before.publishAt !== null && Date.parse(before.publishAt) <= deps.clock.now().getTime() + MARGIN_MS) {
      return { at, action, publishAt, result: "refused", reason: "the video's date is within 15 minutes" };
    }
    if (!sameInstant(before.publishAt, publishAt)) await deps.write(row, publishAt);
    const after = await deps.read(row);
    if (after.privacyStatus === "private" && sameInstant(after.publishAt, publishAt)) return { at, action, publishAt, result: "verified" };
    return { at, action, publishAt, result: "mismatch", reason: `read back as ${after.publishAt ?? "no date"} (${after.privacyStatus ?? "no privacy status"})` };
  }

  return {
    /** One pass over the finished uploads with a slot; a row whose date already matches the plan costs no YouTube call. */
    async tick(): Promise<{ changed: number }> {
      // Review #4: switched off or out of quota -> nothing is read, nothing is written, nothing recorded.
      if (deps.clock.now().getTime() < quotaPausedUntil) return { changed: 0 };
      if (!(await deps.liveWritesEnabled()) || !(await deps.dataReadsEnabled())) return { changed: 0 };
      const rows = await deps.rows();
      const byChannel = new Map<string, Map<string, SlotDecision>>();
      const removedByChannel = new Map<string, ReadonlySet<string> | null>();
      /** The channel's removed list, read once per pass; null when it cannot be read. */
      const removedOf = async (channelId: string): Promise<ReadonlySet<string> | null> => {
        if (!removedByChannel.has(channelId)) removedByChannel.set(channelId, deps.removedVideoIds ? await deps.removedVideoIds(channelId).catch(() => null) : new Set<string>());
        return removedByChannel.get(channelId) ?? null;
      };
      let changed = 0;
      for (const row of rows) {
        if (!row.slotId || !row.videoId || row.status !== "done") continue;
        let decisions = byChannel.get(row.channelId);
        if (!decisions) {
          decisions = await deps.slotDecisions(row.channelId);
          byChannel.set(row.channelId, decisions);
        }
        const decision = decisionForRow(row, decisions);
        // BL-243 review round 6: a `video_missing` row whose video is no longer marked removed (it reappeared) is not done -- its
        // stored "no date" is not YouTube's word any more, so a veto asks YouTube again (the live read removes a date if there is
        // one); an approval dates it as usual.
        const reappeared = stepsOf(row).planSync?.result === "video_missing" && (await removedOf(row.channelId))?.has(row.videoId) === false;
        const want = reappeared && decision?.kind === "vetoed" ? { publishAt: null } : desiredDate(row, decision, deps.clock.now().getTime());
        if (!want) continue;
        // BL-243 (ADR 0063 §4): a video the sync found removed is never dated; an unreadable list dates nothing of the channel
        // (fail closed). Removing a date never waits on the list: YouTube's own answer decides (`missing`: nothing to do).
        if (want.publishAt !== null) {
          const removed = await removedOf(row.channelId);
          if (!removed || removed.has(row.videoId)) continue;
        }
        const steps = stepsOf(row);
        const action = want.publishAt === null ? "unscheduled" : "scheduled";
        const at = deps.clock.now().toISOString();
        let result: NonNullable<UploadSteps["planSync"]>;
        try {
          result = await change(row, want.publishAt, action, at);
        } catch (error) {
          const code = errorCode(error);
          // Live writes off, reads off or the quota (nothing was written): the pass stops, the next one tries again. Anything else is
          // recorded (tried again in an hour).
          if (code !== null && RETRY_LATER.has(code)) return { changed };
          // Review #4: the quota is out -- recorded (the hourly retry applies to the row) and the whole pass waits for the reset.
          if (code === "youtube_quota_exceeded") quotaPausedUntil = deps.nextQuotaReset(deps.clock.now()).getTime();
          result = { at, action, publishAt: want.publishAt, result: "refused", reason: code ?? "unknown_error" };
        }
        // BL-243 review round 3: YouTube's "no such video" is final only when a completed owner removed-check also marked the video;
        // otherwise it is a refusal like any other (tried again after the hour), so a wrong answer never lets a vetoed video keep its
        // date. A confirmed one: the video carries no date -- the row says so, and a veto has nothing left to remove.
        if (result.result === "video_missing" && !(await removedOf(row.channelId))?.has(row.videoId)) {
          result = { ...result, result: "refused", reason: "not_found without a removed mark from a completed sync" };
        }
        const stored = result.result === "verified" || (result.result === "video_missing" && want.publishAt === null) ? want.publishAt : row.publishAt;
        const nextSteps: UploadSteps = { ...steps, planSync: result, ...(result.result === "verified" && want.publishAt !== null ? { publishAt: "set" as const } : {}) };
        if (await deps.update(row, { publishAt: stored, stepsJson: JSON.stringify(nextSteps) })) {
          changed += 1;
          await deps.audit(row, { event: action === "unscheduled" ? "publishing.plan_unscheduled" : "publishing.plan_scheduled", uploadId: row.id, video: row.video, slotId: row.slotId, previous: row.publishAt, ...result });
        }
        if (deps.clock.now().getTime() < quotaPausedUntil) return { changed };
      }
      return { changed };
    },
  };
}

export type PlanSchedule = ReturnType<typeof createPlanSchedule>;
