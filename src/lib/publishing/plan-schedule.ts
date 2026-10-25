// BL-225 stage 3 (WEEKLY_PUBLISHING_PLAN.md stage 3; ADR 0051 §5, §7, §10; FO-REQ-0040 item 5; owner msg 3537): the weekly plan's
// word on a video this computer already uploaded for a slot. A veto removes its date (the video stays private); an approval -- of a
// slot whose package uploaded before it was approved, or a re-approval with a new time -- sets the slot's time. Only on a finished
// upload whose checks passed (translations, thumbnail, playlist, read-back): a withheld date stays withheld. A slot that is not
// approved now (pending) is left as it is: only a veto stops a release. Each change goes through video-details' own write path
// (identity, backup, Live writes right before the write, read-back) and is read back again here before it is recorded.

import type { StoredPublishingUpload } from "@/lib/db";
import type { SlotDecision } from "./auto-upload";
import type { UploadSteps } from "./upload-runner";

/** video-details' rule: a date within 15 minutes is neither written nor removed (the video could publish meanwhile). */
const MARGIN_MS = 15 * 60_000;
/** A refused or mismatched change is tried again after this long. */
export const RETRY_AFTER_MS = 60 * 60_000;

export type PlanScheduleDeps = {
  /** This computer's finished uploads that name a plan slot and have a video. */
  rows(): Promise<StoredPublishingUpload[]>;
  slotDecisions(channelId: string): Promise<Map<string, SlotDecision>>;
  /** The video's privacy and date as YouTube has them now (read gateway, with the row's account). */
  read(row: StoredPublishingUpload): Promise<{ privacyStatus: string | null; publishAt: string | null }>;
  /** video-details' write: private, with this date or (null) none; the AI flag sent again (YouTube does not return it). */
  write(row: StoredPublishingUpload, publishAt: string | null): Promise<void>;
  /** Stores the row's new date and steps (only while the row is still `done`). */
  update(row: StoredPublishingUpload, set: { publishAt: string | null; stepsJson: string }): Promise<boolean>;
  audit(row: StoredPublishingUpload, detail: Record<string, unknown>): Promise<void>;
  clock: { now(): Date };
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
const RETRY_LATER = new Set(["live_writes_disabled", "data_api_reads_disabled", "youtube_quota_exceeded"]);
function errorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

export function createPlanSchedule(deps: PlanScheduleDeps) {
  /** One change, read before and after: refused when the video is not private or its date is within the margin. */
  async function change(row: StoredPublishingUpload, publishAt: string | null, action: "scheduled" | "unscheduled", at: string): Promise<NonNullable<UploadSteps["planSync"]>> {
    const before = await deps.read(row);
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
      const rows = await deps.rows();
      const byChannel = new Map<string, Map<string, SlotDecision>>();
      let changed = 0;
      for (const row of rows) {
        if (!row.slotId || !row.videoId || row.status !== "done") continue;
        let decisions = byChannel.get(row.channelId);
        if (!decisions) {
          decisions = await deps.slotDecisions(row.channelId);
          byChannel.set(row.channelId, decisions);
        }
        const want = desiredDate(row, decisions.get(row.slotId), deps.clock.now().getTime());
        if (!want) continue;
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
          result = { at, action, publishAt: want.publishAt, result: "refused", reason: code ?? "unknown_error" };
        }
        const stored = result.result === "verified" ? want.publishAt : row.publishAt;
        const nextSteps: UploadSteps = { ...steps, planSync: result, ...(result.result === "verified" && want.publishAt !== null ? { publishAt: "set" as const } : {}) };
        if (await deps.update(row, { publishAt: stored, stepsJson: JSON.stringify(nextSteps) })) {
          changed += 1;
          await deps.audit(row, { event: action === "unscheduled" ? "publishing.plan_unscheduled" : "publishing.plan_scheduled", uploadId: row.id, video: row.video, slotId: row.slotId, previous: row.publishAt, ...result });
        }
      }
      return { changed };
    },
  };
}

export type PlanSchedule = ReturnType<typeof createPlanSchedule>;
