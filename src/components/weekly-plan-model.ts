// BL-225 (WEEKLY_PUBLISHING_PLAN.md stage 1 item 6): the pure part of Контент → «План недели» -- which week opens, the steps a slot
// went through, which slots the week's approval covers, and a time in a zone. Shapes are the routes' answers, restated here so a
// client component never imports the server module.

export type PlanSlotStatus = "planned" | "built" | "packaged" | "uploading" | "scheduled" | "published" | "failed" | "vetoed";

export type PlanSlotDto = {
  slotId: string;
  date: string;
  publishAt: string;
  publishAtUtc: string;
  lengthHint: string | null;
  note: string | null;
  contentHash: string;
  approval: "approved" | "needs_approval";
  approvedAt: string | null;
  changedAfterApproval: { previous: { date: string; publishAt: string; lengthHint: string | null; note: string | null; timeZone: string }; approvedAt: string; changedAt: string; changedBy: "factory" | "worker" } | null;
  vetoed: { at: string; device: string | null } | null;
  status: PlanSlotStatus;
  statusCode: string | null;
  videoId: string | null;
  /** BL-225 stage 2: the release package that names the slot. */
  package: { video: string; title: string; durationSeconds: number; languages: string[]; containsSyntheticMedia: boolean; thumbnailPath: string | null; testThumbnails: number; problems: string[] } | null;
  released: boolean;
  updatedAt: string;
  updatedBy: "factory" | "worker";
};

export type PlanSummaryDto = {
  weekStart: string;
  weekEnd: string;
  timeZone: string;
  state: "empty" | "awaiting_approval" | "approved" | "past";
  counts: { slots: number; approved: number; needsApproval: number; vetoed: number };
  firstRelease: string | null;
  createdAt: string;
  createdBy: "factory" | "worker";
  updatedAt: string;
  updatedBy: "factory" | "worker";
};

export type PlanDto = PlanSummaryDto & { slots: PlanSlotDto[] };

const DAY_MS = 86_400_000;

/** The Monday of the week holding `date` (`YYYY-MM-DD`). */
export function mondayOf(date: string): string {
  const at = Date.parse(`${date}T00:00:00Z`);
  const weekday = (new Date(at).getUTCDay() + 6) % 7; // Monday 0 .. Sunday 6
  return new Date(at - weekday * DAY_MS).toISOString().slice(0, 10);
}

export const shiftWeek = (weekStart: string, weeks: number): string => new Date(Date.parse(`${weekStart}T00:00:00Z`) + weeks * 7 * DAY_MS).toISOString().slice(0, 10);

/**
 * The week the screen opens on: the earliest plan still waiting for the owner; else the plan of this week; else the next plan
 * ahead; else this week (no plan yet).
 */
export function defaultWeek(plans: readonly Pick<PlanSummaryDto, "weekStart" | "counts">[], today: string): string {
  const thisWeek = mondayOf(today);
  const waiting = plans.filter((p) => p.counts.needsApproval > 0).map((p) => p.weekStart).sort();
  if (waiting.length > 0) return waiting[0];
  if (plans.some((p) => p.weekStart === thisWeek)) return thisWeek;
  const ahead = plans.map((p) => p.weekStart).filter((w) => w > thisWeek).sort();
  return ahead[0] ?? thisWeek;
}

/** The slots «Одобрить неделю» covers: not vetoed, not released, not approved -- each with the hash the screen shows. */
export function slotsToApprove(plan: Pick<PlanDto, "slots">): Array<{ slotId: string; contentHash: string }> {
  return plan.slots.filter((s) => !s.vetoed && !s.released && s.approval === "needs_approval").map((s) => ({ slotId: s.slotId, contentHash: s.contentHash }));
}

export type PipelineStep = "plan" | "video" | "package" | "youtube" | "date";
export type PipelineStepState = "done" | "active" | "failed" | "todo";

const ORDER: PipelineStep[] = ["plan", "video", "package", "youtube", "date"];
/** How far each status got: the last step done, and the one under way (if any). */
const REACHED: Record<Exclude<PlanSlotStatus, "vetoed" | "failed">, { done: number; active: PipelineStep | null }> = {
  planned: { done: 1, active: null },
  built: { done: 2, active: null },
  packaged: { done: 3, active: null },
  uploading: { done: 3, active: "youtube" },
  scheduled: { done: 5, active: null },
  published: { done: 5, active: null },
};

/** The steps План › Видео › Пакет › YouTube › Дата for a slot; null for a vetoed one (shown as a dash). */
export function pipelineOf(slot: Pick<PlanSlotDto, "status">): Array<{ step: PipelineStep; state: PipelineStepState }> | null {
  if (slot.status === "vetoed") return null;
  if (slot.status === "failed") return ORDER.map((step, i) => ({ step, state: i < 3 ? "done" : step === "youtube" ? "failed" : "todo" }));
  const reached = REACHED[slot.status];
  return ORDER.map((step, i) => ({ step, state: i < reached.done ? "done" : step === reached.active ? "active" : "todo" }));
}

/** Packages ready / scheduled on YouTube, for the tiles. */
export function tileCounts(plan: Pick<PlanDto, "slots">): { packaged: number; scheduled: number } {
  const live = plan.slots.filter((s) => s.status !== "vetoed");
  return {
    packaged: live.filter((s) => ["packaged", "uploading", "scheduled", "published"].includes(s.status)).length,
    scheduled: live.filter((s) => s.status === "scheduled" || s.status === "published").length,
  };
}

/** An instant's `DD.MM`, `HH:MM` and weekday (0 = Monday) in a zone (null zone: the browser's). */
export function zonedParts(iso: string, timeZone: string | null): { day: string; time: string; weekday: number; ymd: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: timeZone ?? undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value])
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday);
  return { day: `${parts.day}.${parts.month}`, time: `${parts.hour}:${parts.minute}`, weekday, ymd: `${parts.year}-${parts.month}-${parts.day}` };
}

/** The local wall time `YYYY-MM-DDTHH:MM` as `DD.MM` and `HH:MM` (the channel's own time, no conversion). */
export function wallParts(publishAt: string): { day: string; time: string; weekday: number } {
  const date = publishAt.slice(0, 10);
  return { day: `${date.slice(8, 10)}.${date.slice(5, 7)}`, time: publishAt.slice(11, 16), weekday: (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7 };
}

/** Which field an agent changed after the owner approved (the first that differs, in the order the owner reads them). */
export function changedField(slot: Pick<PlanSlotDto, "date" | "publishAt" | "lengthHint" | "note" | "changedAfterApproval">, timeZone: string): "time" | "length" | "note" | "zone" | null {
  const previous = slot.changedAfterApproval?.previous;
  if (!previous) return null;
  if (previous.publishAt !== slot.publishAt) return "time";
  if ((previous.lengthHint ?? null) !== (slot.lengthHint ?? null)) return "length";
  if ((previous.note ?? null) !== (slot.note ?? null)) return "note";
  if (previous.timeZone !== timeZone) return "zone";
  return null;
}

/** A package's length as the plan screen rounds it: whole hours from one hour, else whole minutes (at least 1). */
export function lengthLabel(seconds: number): { unit: "h" | "min"; value: number } {
  return seconds >= 3600 ? { unit: "h", value: Math.round(seconds / 3600) } : { unit: "min", value: Math.max(1, Math.round(seconds / 60)) };
}
