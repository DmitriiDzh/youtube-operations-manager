// BL-225 (ADR 0051 §2-§5): what a plan and its slots are right now, worked out from what the document holds -- never stored twice.
// Pure apart from hashing.
import { createHash } from "node:crypto";
import type { PublishingPlanDecision, PublishingPlanMeta, PublishingPlanSlot, PublishingPlanSlotContent } from "@/lib/sync-gateway";
import { formatZonedDateAndTime, zonedInstant } from "@/lib/zoned-time";
import type { PlanSlotProgress, PlanSlotView, PlanState, PlanSummary, PlanView } from "./contracts";

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

/** What an approval names (ADR 0051 §3): every field of the slot, with the plan's zone. */
export function contentHashOf(timeZone: string, content: PublishingPlanSlotContent): string {
  return createHash("sha256").update(JSON.stringify([timeZone, content.date, content.publishAt, content.lengthHint ?? null, content.note ?? null])).digest("hex");
}

export const contentOf = (slot: PublishingPlanSlotContent): PublishingPlanSlotContent => ({ date: slot.date, publishAt: slot.publishAt, lengthHint: slot.lengthHint ?? null, note: slot.note ?? null });

/** Review #7: the counter first (a decision made after another sorts after it), the wall clock and the id only as tiebreaks. */
const byTime = (a: PublishingPlanDecision, b: PublishingPlanDecision) => (a.seq ?? 0) - (b.seq ?? 0) || Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id);

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
  const veto = sorted.filter((d) => d.kind === "vetoed" || d.kind === "restored").at(-1);
  return {
    approved,
    approvedAt: approved ? current!.at : null,
    superseded,
    vetoed: veto?.kind === "vetoed" ? { at: veto.at, device: veto.device } : null,
  };
}

export function slotViewOf(args: {
  meta: PublishingPlanMeta;
  slot: PublishingPlanSlot;
  decisions: readonly PublishingPlanDecision[];
  progress: PlanSlotProgress | null;
  now: Date;
}): PlanSlotView {
  const { meta, slot, now } = args;
  const content = contentOf(slot);
  const contentHash = contentHashOf(meta.timeZone, content);
  const state = decisionStateOf(args.decisions, contentHash);
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
    approval: state.approved ? "approved" : "needs_approval",
    approvedAt: state.approvedAt,
    changedAfterApproval: state.superseded
      ? { previous: { ...state.superseded.snapshot }, approvedAt: state.superseded.at, changedAt: slot.updatedAt, changedBy: slot.updatedBy }
      : null,
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

/** The plan's state (WEEKLY_PUBLISHING_PLAN.md stage 1 item 2). */
export function planStateOf(slots: readonly PlanSlotView[]): PlanState {
  if (slots.length === 0) return "empty";
  if (slots.some(needsOwner)) return "awaiting_approval";
  return slots.every((s) => s.released) ? "past" : "approved";
}

/** A slot the owner still has to decide on: not vetoed, not released, not approved. */
export const needsOwner = (s: PlanSlotView): boolean => !s.vetoed && !s.released && s.approval === "needs_approval";

export function planViewOf(args: {
  channelId: string;
  meta: PublishingPlanMeta;
  slots: readonly PublishingPlanSlot[];
  decisions: readonly PublishingPlanDecision[];
  progress: Map<string, PlanSlotProgress>;
  now: Date;
}): PlanView {
  const views = args.slots
    .map((slot) => slotViewOf({ meta: args.meta, slot, decisions: args.decisions.filter((d) => d.slotId === slot.slotId), progress: args.progress.get(slot.slotId) ?? null, now: args.now }))
    .sort((a, b) => Date.parse(a.publishAtUtc) - Date.parse(b.publishAtUtc) || a.slotId.localeCompare(b.slotId));
  const live = views.filter((s) => !s.vetoed);
  const summary: PlanSummary = {
    channelId: args.channelId,
    weekStart: args.meta.weekStart,
    weekEnd: weekEndOf(args.meta.weekStart),
    timeZone: args.meta.timeZone,
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
