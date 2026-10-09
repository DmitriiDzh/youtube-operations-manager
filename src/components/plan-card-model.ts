import { sharedNotices, validatorOfEntry, type PlanEvent, type PlanItemProgress, type PlanNotice, type PlanProgress, type PlanStageCounts, type PlanStageKind, type PlanView } from "@/lib/generation-plans/contracts";
import type { SharedPlan } from "@/lib/sync-gateway";

// BL-162 (MEDIA_UX_REDESIGN_PLAN.md §5.1, FO-REQ-0013): one Plans card for every plan, wherever it was created. This
// device's plan comes from its own core; another device's from that device's report, where `progress` is a loose record
// (shown, never recomputed -- BL-143 phase 2) that an older build may have written with fewer fields. Pure, so the rules
// are tested on their own.

/** Where a plan lives: null = this computer. `version` = that device's report version (BL-162: wave notes need 3). */
export type PlanCardDevice = { deviceId: string; hostname: string | null; updatedAt: string; stale: boolean; version?: number } | null;

/** BL-162 (FO-REQ-0013 §2.3): a wave note sent from here to another device's plan. */
export type OutgoingNoteRef = { ownerDeviceId: string; planId: string; groupId: string; note: string | null; at: string };

export type PlanCardModel = {
  planId: string;
  title: string;
  owner: "factory" | "operator";
  status: string;
  createdAt: string;
  note: string | null;
  /** Whether validator-rejected tracks wait for the owner too; null = not known here (another device's plan). */
  reviewRejected: boolean | null;
  groups: Array<{ groupId: string; title: string; dependsOn: string | null; note: string | null; ownerNote: string | null; ownerNoteAt?: string | null }>;
  progress: PlanProgress;
  events: PlanEvent[];
  /** The tracks waiting for the owner's verdict (another device's: minus the verdicts already sent from here). */
  waiting: number;
  device: PlanCardDevice;
  /**
   * BL-162 (FO-REQ-0013 §2.3): whether a wave note can be written here -- this device's plan ("own"), another device's that can
   * take it ("relay"), or one whose app is too old for it ("update_required").
   */
  notes: "own" | "relay" | "update_required";
  /** Wave notes sent from here that the owning device has not shown applied yet, by wave. */
  pendingNotes: Record<string, { note: string | null; at: string }>;
};

/** A verdict this computer sent to another device's plan, not yet shown applied there. */
export type OutgoingVerdictRef = { ownerDeviceId: string; planId: string; itemKey: string; attemptRef: string };

/** This device's plan as the card shows it. */
export function ownPlanModel(detail: PlanView & { events: PlanEvent[] }): PlanCardModel {
  const { plan, progress } = detail;
  return {
    planId: plan.planId,
    title: plan.title,
    owner: plan.owner,
    status: plan.status,
    createdAt: plan.createdAt,
    note: plan.note,
    reviewRejected: plan.reviewRejected === true,
    groups: plan.groups.map((g) => ({ groupId: g.groupId, title: g.title, dependsOn: g.dependsOn ?? null, note: g.note ?? null, ownerNote: g.ownerNote ?? null })),
    progress,
    events: detail.events,
    waiting: progress.items.reduce((sum, i) => sum + i.waitingReview, 0),
    device: null,
    notes: "own",
    pendingNotes: {},
  };
}

/**
 * BL-162 (MEDIA_UX_REDESIGN_PLAN.md §5.2): the notes sent from here that are still on their way -- the newest per wave whose
 * time is later than the owning device's current note (`ownerNoteAt`). Equal = it was applied; earlier = a newer note won there.
 * Exported for its test.
 */
export function pendingNotesOf(groups: ReadonlyArray<{ groupId: string; ownerNoteAt?: string | null }>, sent: readonly OutgoingNoteRef[]): Record<string, { note: string | null; at: string }> {
  const out: Record<string, { note: string | null; at: string }> = {};
  for (const g of groups) {
    const newest = sent.filter((n) => n.groupId === g.groupId).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    if (!newest) continue;
    const there = g.ownerNoteAt ? Date.parse(g.ownerNoteAt) : Number.NEGATIVE_INFINITY;
    if (Date.parse(newest.at) > there) out[g.groupId] = { note: newest.note, at: newest.at };
  }
  return out;
}

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && !Array.isArray(x)) : []) as Record<string, unknown>[];
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const STAGE_KINDS: readonly PlanStageKind[] = ["in_app", "external", "owner_review"];

function stageCounts(v: unknown): PlanStageCounts {
  const c = record(v);
  return { planned: num(c.planned), queued: num(c.queued), running: num(c.running), done: num(c.done), failed: num(c.failed), interrupted: num(c.interrupted), cancelled: num(c.cancelled), accepted: num(c.accepted), rejected: num(c.rejected) };
}

/** Another device's `progress` (a loose record) in the card's shape: what is missing or malformed reads as empty or zero. */
export function sharedProgress(raw: Record<string, unknown>): PlanProgress {
  const spend = record(raw.spend);
  const budget = record(raw.budget);
  const eta = record(raw.eta);
  return {
    stages: list(raw.stages)
      .filter((s) => typeof s.stageId === "string" && STAGE_KINDS.includes(s.kind as PlanStageKind))
      .map((s) => ({ stageId: str(s.stageId), title: str(s.title, str(s.stageId)), kind: s.kind as PlanStageKind, counts: stageCounts(s.counts) })),
    groups: list(raw.groups)
      .filter((g) => typeof g.groupId === "string")
      .map((g) => {
        const c = record(g.counts);
        return { groupId: str(g.groupId), title: str(g.title, str(g.groupId)), counts: { items: num(c.items), generated: num(c.generated), accepted: num(c.accepted), rejected: num(c.rejected), waitingReview: num(c.waitingReview), missing: num(c.missing) } };
      }),
    items: list(raw.items)
      .filter((i) => typeof i.itemKey === "string")
      .map(
        (i): PlanItemProgress => ({
          itemKey: str(i.itemKey),
          groupId: strOrNull(i.groupId),
          targetCount: num(i.targetCount),
          mode: i.mode === "until_accepted" ? "until_accepted" : "fixed",
          attempts: num(i.attempts),
          generated: num(i.generated),
          accepted: num(i.accepted),
          rejected: num(i.rejected),
          open: num(i.open),
          waitingReview: num(i.waitingReview),
          pending: num(i.pending),
          missing: num(i.missing),
        })
      ),
    spend: {
      usd: num(spend.usd),
      gpuMinutes: num(spend.gpuMinutes),
      sessions: list(spend.sessions).map((s) => ({ sessionId: str(s.sessionId), status: str(s.status), gpuTypeId: strOrNull(s.gpuTypeId), usd: num(s.usd), final: s.final !== false, stopReason: strOrNull(s.stopReason) })),
    },
    budget: { usd: numOrNull(budget.usd), usedShare: numOrNull(budget.usedShare), warnings: (Array.isArray(budget.warnings) ? budget.warnings : []).filter((w): w is "80" | "100" => w === "80" || w === "100") },
    eta: { seconds: numOrNull(eta.seconds), gpuTypeId: strOrNull(eta.gpuTypeId), samples: num(eta.samples) },
    notices: sharedNotices(raw),
  };
}

/**
 * Another device's plan as the card shows it, from that device's report. The waiting count is its review entries without a
 * verdict, less the verdicts this computer already sent there (they wait for that device to apply them).
 */
export function peerPlanModel(plan: SharedPlan, device: NonNullable<PlanCardDevice>, outgoing: readonly OutgoingVerdictRef[], outgoingNotes: readonly OutgoingNoteRef[] = []): PlanCardModel {
  const sent = new Set(outgoing.filter((v) => v.ownerDeviceId === device.deviceId && v.planId === plan.planId).map((v) => `${v.itemKey}\u0000${v.attemptRef}`));
  const open = plan.review.filter((e) => e.verdict === null && !sent.has(`${e.itemKey}\u0000${e.attemptRef}`));
  const waiting = open.length;
  const rejected = open.filter((e) => validatorOfEntry(e) === "rejected").length;
  const reported = sharedProgress(plan.progress);
  // The waves' and items' waiting counts follow the same rule as the header (review): a track rated from here is not waiting.
  const progress: PlanProgress = {
    ...reported,
    groups: reported.groups.map((g) => ({ ...g, counts: { ...g.counts, waitingReview: open.filter((e) => e.groupId === g.groupId).length } })),
    items: reported.items.map((i) => ({ ...i, waitingReview: open.filter((e) => e.itemKey === i.itemKey).length })),
  };
  // `review_waiting` is not taken from the report (`sharedNotices`): this computer counts it itself, with its sent verdicts.
  const notices: PlanNotice[] = waiting > 0 ? [...progress.notices, { kind: "review_waiting", count: waiting, passed: waiting - rejected, rejected }] : progress.notices;
  return {
    planId: plan.planId,
    title: plan.title,
    owner: plan.owner,
    status: plan.status,
    createdAt: plan.createdAt,
    note: plan.note,
    // Not in the report; validator-rejected tracks in its queue mean the option is on there (BL-153: they wait only then).
    reviewRejected: plan.review.some((e) => e.verdict === null && validatorOfEntry(e) === "rejected") ? true : null,
    groups: plan.groups.map((g) => ({ groupId: g.groupId, title: g.title, dependsOn: g.dependsOn, note: g.note, ownerNote: g.ownerNote ?? null, ownerNoteAt: g.ownerNoteAt ?? null })),
    progress: { ...progress, notices },
    events: plan.events.map((e) => ({ at: e.at, kind: e.kind, actor: e.actor, details: e.details })),
    waiting,
    device,
    notes: (device.version ?? 1) >= 3 ? "relay" : "update_required",
    pendingNotes: pendingNotesOf(plan.groups, outgoingNotes.filter((n) => n.ownerDeviceId === device.deviceId && n.planId === plan.planId)),
  };
}

export type WaveRow = { groupId: string; title: string; dependsOn: string | null; note: string | null; ownerNote: string | null; ownerNoteAt?: string | null; counts: PlanProgress["groups"][number]["counts"] | null };

/**
 * BL-162 (AC-UX-10): the plan's waves for the card, newest first (the reverse of the plan's order). Shown: every wave with
 * a track waiting for the owner, and the newest wave; the others are folded (`folded` counts them) unless `showAll`.
 */
export function waveRows(model: Pick<PlanCardModel, "groups" | "progress">, showAll: boolean): { shown: WaveRow[]; folded: number } {
  const rows: WaveRow[] = model.groups.map((g) => ({ ...g, counts: model.progress.groups.find((x) => x.groupId === g.groupId)?.counts ?? null })).reverse();
  const keep = (row: WaveRow, i: number) => i === 0 || (row.counts?.waitingReview ?? 0) > 0;
  if (showAll) return { shown: rows, folded: 0 };
  const shown = rows.filter(keep);
  return { shown, folded: rows.length - shown.length };
}
