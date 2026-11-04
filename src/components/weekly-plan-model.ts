// BL-225 (WEEKLY_PUBLISHING_PLAN.md stage 1 item 6): the pure part of Контент → «План недели» -- which week opens, the steps a slot
// went through, which slots the week's approval covers, and a time in a zone. Shapes are the routes' answers, restated here so a
// client component never imports the server module.

export type PlanSlotStatus = "planned" | "built" | "packaged" | "uploading" | "scheduled" | "published" | "failed" | "vetoed";

/** BL-242 (ADR 0062 §2): the package an approval names. */
export type PackageFingerprintDto = { video: string; manifestSha256: string; videoId: string | null };

/** BL-242 (ADR 0062 §1): the channel's approval stage (the switch «Одобрять пустые слоты» = `slot`). */
export type ApprovalStage = "packaged" | "slot";

export type PlanSlotDto = {
  slotId: string;
  date: string;
  publishAt: string;
  publishAtUtc: string;
  lengthHint: string | null;
  note: string | null;
  contentHash: string;
  /** BL-242: `awaiting_package` -- the `packaged` stage, no ready or uploaded package yet: nothing to approve. */
  approval: "approved" | "needs_approval" | "awaiting_package";
  approvedAt: string | null;
  /** BL-242: the package the approval names (the `packaged` stage), else null/absent. */
  fingerprint?: PackageFingerprintDto | null;
  changedAfterApproval: {
    previous: { date: string; publishAt: string; lengthHint: string | null; note: string | null; timeZone: string; package?: PackageFingerprintDto };
    approvedAt: string;
    changedAt: string;
    changedBy: "factory" | "worker";
  } | null;
  /** BL-240: the slot this one replaces (approving this one pulls it), or null. */
  replaces: { slotId: string; weekStart: string | null; publishAt: string | null; video: string | null; vetoed: boolean; released: boolean; found: boolean } | null;
  /** `replacedBy`: pulled by the owner's approval of the slot that replaces it (BL-240). */
  vetoed: { at: string; device: string | null; replacedBy?: string } | null;
  status: PlanSlotStatus;
  statusCode: string | null;
  videoId: string | null;
  /** BL-225 stage 2: the release package that names the slot. */
  package: { video: string; title: string; durationSeconds: number; languages: string[]; containsSyntheticMedia: boolean; thumbnailPath: string | null; testThumbnails: number; problems: string[]; manifestSha256?: string | null } | null;
  released: boolean;
  /** BL-242 R3: the date the slot's uploaded video carries on YouTube (UTC), or null/absent. */
  youtubePublishAt?: string | null;
  updatedAt: string;
  updatedBy: "factory" | "worker";
};

export type PlanSummaryDto = {
  weekStart: string;
  weekEnd: string;
  timeZone: string;
  /** BL-242: absent from an older server (read as `slot`, the behaviour it has). */
  approvalStage?: ApprovalStage;
  state: "empty" | "planned" | "awaiting_approval" | "approved" | "past";
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

/** A slot the owner can approve now: not vetoed, not released, needing approval (BL-242: never one waiting for its package). */
export const canApprove = (s: Pick<PlanSlotDto, "vetoed" | "released" | "approval">): boolean => !s.vetoed && !s.released && s.approval === "needs_approval";

/**
 * The slots «Одобрить неделю» (BL-242 `packaged` stage: «Одобрить все готовые») covers: those the owner can approve now -- each
 * with the hash the screen shows.
 */
export function slotsToApprove(plan: Pick<PlanDto, "slots">): Array<{ slotId: string; contentHash: string }> {
  return plan.slots.filter(canApprove).map((s) => ({ slotId: s.slotId, contentHash: s.contentHash }));
}

/**
 * BL-242 R3: the date a slot's video carries on YouTube while no approval of the slot counts (needs approval, or waits for its
 * package) -- shown so the owner approves (the date moves to the slot's time) or vetoes (the date goes). Null otherwise.
 */
export const strayDateOf = (s: Pick<PlanSlotDto, "approval" | "vetoed"> & { youtubePublishAt?: string | null }): string | null =>
  !s.vetoed && s.approval !== "approved" && s.youtubePublishAt ? s.youtubePublishAt : null;

/** BL-242: the stage a plan list answer names; an older server names none and behaves as `slot`. */
export const stageOf = (answer: { approvalStage?: ApprovalStage } | null | undefined): ApprovalStage => answer?.approvalStage ?? "slot";

/**
 * BL-240 (A): the plan's slots in its order, split into the live ones and the pulled ones (listed under one closed row). `number`
 * is the slot's place in the whole plan, so a slot keeps its «Слот N» whether the pulled ones are shown or not.
 */
export function splitVetoed<T extends Pick<PlanSlotDto, "vetoed">>(slots: readonly T[]): { live: Array<{ slot: T; number: number }>; vetoed: Array<{ slot: T; number: number }> } {
  const numbered = slots.map((slot, i) => ({ slot, number: i + 1 }));
  return { live: numbered.filter((s) => !s.slot.vetoed), vetoed: numbered.filter((s) => s.slot.vetoed) };
}

/** BL-240 (C): the replaced slots that approving these slots would pull -- found, not pulled yet, not past; each once. */
export function replacedToPull(slots: ReadonlyArray<Pick<PlanSlotDto, "replaces">>): Array<NonNullable<PlanSlotDto["replaces"]>> {
  const out: Array<NonNullable<PlanSlotDto["replaces"]>> = [];
  for (const { replaces } of slots) {
    if (replaces && replaces.found && !replaces.vetoed && !replaces.released && !out.some((r) => r.slotId === replaces.slotId)) out.push(replaces);
  }
  return out;
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

/**
 * Which field changed after the owner approved (the first that differs, in the order the owner reads them). BL-242: `package` --
 * the slot is the same but its package is another one (another video or manifest) than the approved one.
 */
export function changedField(slot: Pick<PlanSlotDto, "date" | "publishAt" | "lengthHint" | "note" | "changedAfterApproval"> & { package?: PlanSlotDto["package"] }, timeZone: string): "time" | "length" | "note" | "zone" | "package" | null {
  const previous = slot.changedAfterApproval?.previous;
  if (!previous) return null;
  if (previous.publishAt !== slot.publishAt) return "time";
  if ((previous.lengthHint ?? null) !== (slot.lengthHint ?? null)) return "length";
  if ((previous.note ?? null) !== (slot.note ?? null)) return "note";
  if (previous.timeZone !== timeZone) return "zone";
  if (previous.package && (previous.package.video !== slot.package?.video || previous.package.manifestSha256 !== (slot.package?.manifestSha256 ?? null))) return "package";
  return null;
}

/** A package's length as the plan screen rounds it: whole hours from one hour, else whole minutes (at least 1). */
export function lengthLabel(seconds: number): { unit: "h" | "min"; value: number } {
  return seconds >= 3600 ? { unit: "h", value: Math.round(seconds / 3600) } : { unit: "min", value: Math.max(1, Math.round(seconds / 60)) };
}

/** BL-235: the week's coverage on YouTube as the route gives it (the shared publishing coverage, the plan's zone). */
export type WeekCoverageDto = {
  asOf: string | null;
  days: Array<{ date: string; status: "covered" | "missing_translations" | "gap"; missingLanguages: string[] }>;
  summary: { covered: number; missingTranslations: number; gaps: number };
};

/**
 * BL-235 (owner msg 3806): the line «Закрыто 4 из 7 · без видео: … · без переводов: …» -- the days without a video and the days
 * whose video lacks translations (with the languages), in date order. Pure: the panel formats the dates.
 */
export function weekCoverageLine(coverage: WeekCoverageDto): { covered: number; total: number; gaps: string[]; missing: Array<{ date: string; languages: string[] }> } {
  return {
    covered: coverage.summary.covered,
    total: coverage.days.length,
    gaps: coverage.days.filter((day) => day.status === "gap").map((day) => day.date),
    missing: coverage.days.filter((day) => day.status === "missing_translations").map((day) => ({ date: day.date, languages: day.missingLanguages })),
  };
}
