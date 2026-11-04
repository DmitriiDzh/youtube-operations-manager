// BL-225 (ADR 0051 §2-§5): what a plan and its slots are right now, worked out from what the document holds -- never stored twice.
// Pure apart from hashing.
import { createHash } from "node:crypto";
import type { PublishingPlanApprovalStage, PublishingPlanDecision, PublishingPlanMeta, PublishingPlanPackageFingerprint, PublishingPlanSlot, PublishingPlanSlotContent } from "@/lib/sync-gateway";
import { formatZonedDateAndTime, zonedInstant } from "@/lib/zoned-time";
import type { PlanSlotProgress, PlanSlotView, PlanState, PlanSummary, PlanView, ReplacedSlot } from "./contracts";

const DAY_MS = 86_400_000;

/** A real calendar date `YYYY-MM-DD`. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export const isMonday = (date: string): boolean => new Date(`${date}T00:00:00Z`).getUTCDay() === 1;

/** The date `days` after `date` (calendar arithmetic, no zone). */
export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The week a plan covers: its Monday to its Sunday, inclusive. */
export const weekEndOf = (weekStart: string): string => addDays(weekStart, 6);

/**
 * The instant of a local wall time `YYYY-MM-DDTHH:MM` in `timeZone`, or null when that time does not exist there (the hour a
 * clock skips when summer time starts) or is malformed.
 */
export function instantOf(publishAt: string, timeZone: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(publishAt);
  if (!match || !isCalendarDate(match[1]) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(match[2])) return null;
  const instant = zonedInstant({ localDate: match[1], localTime: match[2], timezone: timeZone });
  const back = formatZonedDateAndTime(instant, timeZone);
  return back.localDate === match[1] && back.localTime === match[2] ? instant : null;
}

/**
 * What an approval names (ADR 0051 §3): every field of the slot, with the plan's zone. BL-240 (ADR 0060): the replaced slot is
 * appended only when set, so a slot without it keeps the hash it had before (every existing approval stands). BL-242 (ADR 0062
 * §2): in the `packaged` stage the package fingerprint `[video, manifestSha256, videoId|null]` is appended last.
 */
export function contentHashOf(timeZone: string, content: PublishingPlanSlotContent, fingerprint?: PublishingPlanPackageFingerprint | null): string {
  const fields: unknown[] = [timeZone, content.date, content.publishAt, content.lengthHint ?? null, content.note ?? null];
  if (content.replacesSlotId) fields.push(content.replacesSlotId);
  if (fingerprint) fields.push([fingerprint.video, fingerprint.manifestSha256, fingerprint.videoId ?? null]);
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** BL-242: the fingerprint of the package the progress reports for a slot, or null (no package, or its manifest unreadable). */
export function fingerprintOf(progress: PlanSlotProgress | null): PublishingPlanPackageFingerprint | null {
  const pkg = progress?.package;
  if (!progress || !pkg || !pkg.manifestSha256) return null;
  return { video: pkg.video, manifestSha256: pkg.manifestSha256, videoId: progress.videoId ?? null };
}

/**
 * BL-242 (ADR 0062 §2): the owner can approve the slot's package -- it is uploaded (a video id) or ready (packaged, no problems).
 */
export function packageReady(progress: PlanSlotProgress | null): boolean {
  if (!fingerprintOf(progress)) return false;
  return progress!.videoId != null || (progress!.status === "packaged" && progress!.package!.problems.length === 0);
}

/**
 * BL-242: an approval made with `approved` names the package `current` is: the same video and manifest, and the same video id --
 * an approval made before the upload (no video id) also covers the video that upload made of that manifest.
 */
export function fingerprintCovers(approved: PublishingPlanPackageFingerprint, current: PublishingPlanPackageFingerprint | null): boolean {
  return current !== null && approved.video === current.video && approved.manifestSha256 === current.manifestSha256 && (approved.videoId === null || approved.videoId === current.videoId);
}

/**
 * BL-242 (ADR 0062 §2): the decisions that count in a stage. `packaged`: approvals and revocations made with a fingerprint only (an
 * approval of the empty slot does not count); `slot`: those made without one (BL-225). Vetoes and restores count in both.
 */
export function decisionsForStage(decisions: readonly PublishingPlanDecision[], stage: PublishingPlanApprovalStage): PublishingPlanDecision[] {
  return decisions.filter((d) => (d.kind !== "approved" && d.kind !== "revoked") || (stage === "packaged" ? d.package !== undefined : d.package === undefined));
}

/**
 * BL-242: in the `packaged` stage, the approval the slot stands on -- the newest approval or revocation (made with a fingerprint)
 * whose hash still matches the slot's content now; null when that one is a revocation or there is none. The uploads (which see no
 * package) and the screen use the same record, so both say the same.
 */
export function standingPackageApprovalOf(decisions: readonly PublishingPlanDecision[], timeZone: string, content: PublishingPlanSlotContent): (PublishingPlanDecision & { package: PublishingPlanPackageFingerprint }) | null {
  const last = [...decisions]
    .sort(byTime)
    .filter((d) => (d.kind === "approved" || d.kind === "revoked") && d.package !== undefined && contentHashOf(timeZone, content, d.package) === d.contentHash)
    .at(-1);
  return last?.kind === "approved" ? (last as PublishingPlanDecision & { package: PublishingPlanPackageFingerprint }) : null;
}

/**
 * BL-242 review #1 (WEEKLY_PUBLISHING_PLAN.md BL-242 D, ADR 0062 §4): in a channel a video number belongs to the NEWEST standing
 * owner approval that names it (counter, then time, then id). Given every slot of the channel (any plan) with its decisions, the
 * ids of the standing approvals that hold their video number; an older one on another slot does not count, on the screen or for
 * the uploads, so two approvals can never name the same video.
 */
export function winningApprovalIds(slots: ReadonlyArray<{ timeZone: string; content: PublishingPlanSlotContent; decisions: readonly PublishingPlanDecision[] }>): Set<string> {
  const byVideo = new Map<string, PublishingPlanDecision>();
  for (const { timeZone, content, decisions } of slots) {
    const standing = standingPackageApprovalOf(decisionsForStage(decisions, "packaged"), timeZone, content);
    if (!standing) continue;
    const before = byVideo.get(standing.package.video);
    if (!before || byTime(before, standing) < 0) byVideo.set(standing.package.video, standing);
  }
  return new Set([...byVideo.values()].map((d) => d.id));
}

/** BL-242: whether an approval stands on the slot's content now (a save that changes it lists it in `unlocked`). */
export function approvalStandsOn(stage: PublishingPlanApprovalStage, timeZone: string, content: PublishingPlanSlotContent, decisions: readonly PublishingPlanDecision[]): boolean {
  const counted = decisionsForStage(decisions, stage);
  return stage === "packaged" ? standingPackageApprovalOf(counted, timeZone, content) !== null : decisionStateOf(counted, contentHashOf(timeZone, content)).approved;
}

export const contentOf = (slot: PublishingPlanSlotContent): PublishingPlanSlotContent => ({
  date: slot.date,
  publishAt: slot.publishAt,
  lengthHint: slot.lengthHint ?? null,
  note: slot.note ?? null,
  ...(slot.replacesSlotId ? { replacesSlotId: slot.replacesSlotId } : {}),
});

/** Review #7: the counter first (a decision made after another sorts after it), the wall clock and the id only as tiebreaks. */
const byTime = (a: PublishingPlanDecision, b: PublishingPlanDecision) => (a.seq ?? 0) - (b.seq ?? 0) || Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id);

/** BL-240: the newest `vetoed` / `restored` record of a slot says whether it is vetoed now (also after the slot was removed). */
export function standingVetoOf(decisions: readonly PublishingPlanDecision[]): PublishingPlanDecision | null {
  const veto = [...decisions].sort(byTime).filter((d) => d.kind === "vetoed" || d.kind === "restored").at(-1);
  return veto?.kind === "vetoed" ? veto : null;
}

/** A slot's approval and veto, from its decisions (any order). */
export function decisionStateOf(decisions: readonly PublishingPlanDecision[], contentHash: string) {
  const sorted = [...decisions].sort(byTime);
  const approvals = sorted.filter((d) => d.kind === "approved" || d.kind === "revoked");
  const current = approvals.filter((d) => d.contentHash === contentHash).at(-1);
  const approved = current?.kind === "approved";
  // The last content the owner approved and did not revoke since, when it is not the content now (an agent changed the slot).
  const lastApproved = approvals.filter((d) => d.kind === "approved").at(-1);
  const stillStanding = lastApproved && approvals.filter((d) => d.contentHash === lastApproved.contentHash).at(-1)?.kind === "approved";
  const superseded = !approved && lastApproved && lastApproved.contentHash !== contentHash && stillStanding ? lastApproved : null;
  const veto = standingVetoOf(sorted);
  return {
    approved,
    approvedAt: approved ? current!.at : null,
    superseded,
    vetoed: veto ? { at: veto.at, device: veto.device, ...(veto.replacedBy ? { replacedBy: veto.replacedBy } : {}) } : null,
  };
}

export function slotViewOf(args: {
  /** BL-242 (ADR 0062 §1): the channel's approval stage. */
  stage: PublishingPlanApprovalStage;
  /** BL-242 review #1: the approvals that hold their video number in the channel (`winningApprovalIds`); absent: every one does. */
  winners?: ReadonlySet<string>;
  meta: PublishingPlanMeta;
  slot: PublishingPlanSlot;
  decisions: readonly PublishingPlanDecision[];
  progress: PlanSlotProgress | null;
  now: Date;
  /** BL-240: the slot named by `replacesSlotId`, as it stands (null: no such slot, or none named). */
  replaces?: ReplacedSlot | null;
}): PlanSlotView {
  const { meta, slot, now } = args;
  const content = contentOf(slot);
  const counted = decisionsForStage(args.decisions, args.stage);
  // BL-242 (ADR 0062 §2): in the `packaged` stage the owner approves the slot with its package; until it has one ready or uploaded
  // there is nothing to approve. The `slot` stage is BL-225's, unchanged.
  let contentHash: string;
  let approval: PlanSlotView["approval"];
  let fingerprint: PlanSlotView["fingerprint"] = null;
  let approvedAt: string | null;
  let superseded: PublishingPlanDecision | null;
  if (args.stage === "packaged") {
    const current = fingerprintOf(args.progress);
    const own = standingPackageApprovalOf(counted, meta.timeZone, content);
    // An approval whose video number a newer approval of another slot holds does not count here.
    const standing = own && (!args.winners || args.winners.has(own.id)) ? own : null;
    if (standing && fingerprintCovers(standing.package, current)) {
      contentHash = standing.contentHash;
      approval = "approved";
      fingerprint = standing.package;
    } else if (packageReady(args.progress)) {
      contentHash = contentHashOf(meta.timeZone, content, current);
      approval = "needs_approval";
      fingerprint = current;
    } else {
      contentHash = contentHashOf(meta.timeZone, content);
      approval = "awaiting_package";
    }
    approvedAt = approval === "approved" ? standing!.at : null;
    superseded = approval === "approved" ? null : (decisionStateOf(counted, contentHash).superseded ?? null);
  } else {
    contentHash = contentHashOf(meta.timeZone, content);
    const own = decisionStateOf(counted, contentHash);
    approval = own.approved ? "approved" : "needs_approval";
    approvedAt = own.approvedAt;
    superseded = own.superseded ?? null;
  }
  const state = { ...decisionStateOf(args.decisions, contentHash), superseded };
  // A stored slot's time is valid in the zone it was saved with; a later zone change could, in theory, land it in a skipped hour.
  const instant = instantOf(slot.publishAt, meta.timeZone) ?? zonedInstant({ localDate: slot.publishAt.slice(0, 10), localTime: slot.publishAt.slice(11, 16), timezone: meta.timeZone });
  // Review #3: the slot is released only once the latest time its video may come out has passed -- its own time, the approved time
  // it still stands on (changed since), and the date its uploaded video carries.
  const releaseMs = Math.max(
    instant.getTime(),
    state.superseded ? (instantOf(state.superseded.snapshot.publishAt, state.superseded.snapshot.timeZone)?.getTime() ?? 0) : 0,
    args.progress?.publishAt ? Date.parse(args.progress.publishAt) || 0 : 0
  );
  return {
    slotId: slot.slotId,
    ...content,
    publishAtUtc: instant.toISOString(),
    contentHash,
    approval,
    fingerprint,
    approvedAt,
    changedAfterApproval: state.superseded
      ? {
          previous: { ...state.superseded.snapshot, ...(state.superseded.package ? { package: { ...state.superseded.package } } : {}) },
          approvedAt: state.superseded.at,
          changedAt: slot.updatedAt,
          changedBy: slot.updatedBy,
        }
      : null,
    replaces: content.replacesSlotId ? (args.replaces ?? { slotId: content.replacesSlotId, weekStart: null, publishAt: null, video: null, vetoed: false, released: false, found: false }) : null,
    vetoed: state.vetoed,
    status: state.vetoed ? "vetoed" : (args.progress?.status ?? "planned"),
    statusCode: state.vetoed ? null : (args.progress?.code ?? null),
    videoId: args.progress?.videoId ?? null,
    package: args.progress?.package ?? null,
    released: releaseMs <= now.getTime(),
    createdAt: slot.createdAt,
    updatedAt: slot.updatedAt,
    updatedBy: slot.updatedBy,
  };
}

/**
 * The plan's state (WEEKLY_PUBLISHING_PLAN.md stage 1 item 2). BL-242: `planned` when nothing waits for the owner but a live
 * future slot still waits for its package (`packaged` stage only).
 */
export function planStateOf(slots: readonly PlanSlotView[]): PlanState {
  if (slots.length === 0) return "empty";
  if (slots.some(needsOwner)) return "awaiting_approval";
  if (slots.every((s) => s.released)) return "past";
  return slots.some((s) => !s.vetoed && !s.released && s.approval === "awaiting_package") ? "planned" : "approved";
}

/** A slot the owner still has to decide on: not vetoed, not released, not approved. */
export const needsOwner = (s: PlanSlotView): boolean => !s.vetoed && !s.released && s.approval === "needs_approval";

export function planViewOf(args: {
  stage: PublishingPlanApprovalStage;
  winners?: ReadonlySet<string>;
  channelId: string;
  meta: PublishingPlanMeta;
  slots: readonly PublishingPlanSlot[];
  decisions: readonly PublishingPlanDecision[];
  progress: Map<string, PlanSlotProgress>;
  now: Date;
  /** BL-240: the replaced slots, by their id. */
  replaced?: Map<string, ReplacedSlot>;
}): PlanView {
  const views = args.slots
    .map((slot) =>
      slotViewOf({
        stage: args.stage,
        ...(args.winners ? { winners: args.winners } : {}),
        meta: args.meta,
        slot,
        decisions: args.decisions.filter((d) => d.slotId === slot.slotId),
        progress: args.progress.get(slot.slotId) ?? null,
        now: args.now,
        replaces: slot.replacesSlotId ? (args.replaced?.get(slot.replacesSlotId) ?? null) : null,
      })
    )
    .sort((a, b) => Date.parse(a.publishAtUtc) - Date.parse(b.publishAtUtc) || a.slotId.localeCompare(b.slotId));
  const live = views.filter((s) => !s.vetoed);
  const summary: PlanSummary = {
    channelId: args.channelId,
    weekStart: args.meta.weekStart,
    weekEnd: weekEndOf(args.meta.weekStart),
    timeZone: args.meta.timeZone,
    approvalStage: args.stage,
    state: planStateOf(views),
    counts: {
      slots: views.length,
      approved: live.filter((s) => s.approval === "approved").length,
      needsApproval: views.filter(needsOwner).length,
      vetoed: views.length - live.length,
    },
    firstRelease: live[0]?.publishAtUtc ?? null,
    createdAt: args.meta.createdAt,
    createdBy: args.meta.createdBy,
    updatedAt: args.meta.updatedAt,
    updatedBy: args.meta.updatedBy,
  };
  return { ...summary, slots: views };
}
