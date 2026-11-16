// BL-267 (docs/roadmap/plans/WEEK_TEMPLATE_PLAN.md §3.1-§3.3, ADR 0073 §1-§2): a channel's week template -- the contract
// `week-template/1`, its canonical hash, which version is in force, and the pure matcher that says which plan slot holds which
// template position. Pure apart from hashing; the services store and decide.
import { createHash } from "node:crypto";
import { z } from "zod";
import { WEEK_TEMPLATE_DAYS, type PublishingPlanTemplateDecision, type PublishingPlanTemplateVersion, type PublishingPlansSnapshot, type WeekTemplateDay, type WeekTemplateDays, type WeekTemplateEntry } from "@/lib/sync-gateway";

export const WEEK_TEMPLATE_FORMAT = "week-template/1" as const;

/** The matcher's fixed rules (ADR 0073 §2; also in `factory_publishing_template_get` as `matchRules`). */
export const TEMPLATE_MATCH_RULES = Object.freeze({
  /** A video of at most this many seconds is a Short (`short`); longer is `long`. */
  shortMaxSeconds: 180,
  /** An entry with `hours` matches a long video within this share of `hours × 3600`. */
  hoursTolerance: 0.1,
  /** The slot's instant must be the entry's UTC weekday and exact UTC minute. */
  time: "exact_minute_utc",
  /** Two slots of one kind on one position: the first created (then the smaller slot id) takes it (owner O4). */
  position: "first_created",
} as const);

export const TEMPLATE_LIMITS = { entriesPerDay: 6, horizonMin: 1, horizonMax: 8, hoursMin: 0.25, hoursMax: 12 } as const;

/** Why a template was refused, one entry per problem (`validation_failed`, `details.refused`). */
export type TemplateRefusal = {
  field: string;
  reason:
    | "unknown_field"
    | "invalid"
    | "channel_mismatch"
    | "time_zone_invalid"
    | "hours_on_short"
    | "hours_invalid"
    | "time_invalid"
    | "too_many_entries"
    | "template_duplicate_entry"
    | "horizon_invalid";
};

const entrySchema = z.object({ kind: z.enum(["long", "short"]), hours: z.number().optional(), publishTimeUtc: z.string() }).strict();
const daysShape = Object.fromEntries(WEEK_TEMPLATE_DAYS.map((d) => [d, z.array(entrySchema).optional()])) as Record<WeekTemplateDay, z.ZodOptional<z.ZodArray<typeof entrySchema>>>;

/** The shape of `week-template/1` as agents and the owner send it (strict: an unknown field is refused). */
export const weekTemplateInputSchema = z
  .object({
    format: z.literal(WEEK_TEMPLATE_FORMAT),
    channelId: z.string().min(1).max(64),
    horizonWeeks: z.number(),
    displayTimeZone: z.string().min(1).max(64).nullable().optional(),
    days: z.object(daysShape).strict(),
  })
  .strict();
export type WeekTemplateInput = z.infer<typeof weekTemplateInputSchema>;

/** A template's content: what its hash names. */
export type WeekTemplateContent = { days: WeekTemplateDays; horizonWeeks: number; displayTimeZone: string | null };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Validates a template against `week-template/1` (AC-WT-01). `isValidZone` checks `displayTimeZone`. Returns the content (entries
 * sorted by time, kind, hours; empty days dropped) or the refusals.
 */
export function validateTemplate(input: unknown, channelId: string, isValidZone: (zone: string) => boolean): { ok: true; content: WeekTemplateContent } | { ok: false; refused: TemplateRefusal[] } {
  const parsed = weekTemplateInputSchema.safeParse(input);
  if (!parsed.success) {
    const refused: TemplateRefusal[] = parsed.error.issues.map((issue) => ({
      field: issue.path.join(".") || (issue.code === "unrecognized_keys" ? (issue as { keys?: string[] }).keys?.join(",") ?? "" : ""),
      reason: issue.code === "unrecognized_keys" ? "unknown_field" : "invalid",
    }));
    return { ok: false, refused };
  }
  const t = parsed.data;
  const refused: TemplateRefusal[] = [];
  if (t.channelId !== channelId) refused.push({ field: "channelId", reason: "channel_mismatch" });
  if (!Number.isInteger(t.horizonWeeks) || t.horizonWeeks < TEMPLATE_LIMITS.horizonMin || t.horizonWeeks > TEMPLATE_LIMITS.horizonMax) refused.push({ field: "horizonWeeks", reason: "horizon_invalid" });
  if (t.displayTimeZone && !isValidZone(t.displayTimeZone)) refused.push({ field: "displayTimeZone", reason: "time_zone_invalid" });
  const days: WeekTemplateDays = {};
  for (const day of WEEK_TEMPLATE_DAYS) {
    const entries = t.days[day] ?? [];
    if (entries.length > TEMPLATE_LIMITS.entriesPerDay) refused.push({ field: `days.${day}`, reason: "too_many_entries" });
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const field = `days.${day}.${index}`;
      const time = TIME.exec(entry.publishTimeUtc);
      if (!time || Number(time[2]) % 5 !== 0) refused.push({ field: `${field}.publishTimeUtc`, reason: "time_invalid" });
      if (entry.hours !== undefined) {
        if (entry.kind === "short") refused.push({ field: `${field}.hours`, reason: "hours_on_short" });
        else if (entry.hours < TEMPLATE_LIMITS.hoursMin || entry.hours > TEMPLATE_LIMITS.hoursMax || Math.round(entry.hours * 4) !== entry.hours * 4) refused.push({ field: `${field}.hours`, reason: "hours_invalid" });
      }
      const key = `${entry.publishTimeUtc}|${entry.kind}|${entry.hours ?? ""}`;
      if (seen.has(key)) refused.push({ field, reason: "template_duplicate_entry" });
      seen.add(key);
    });
    if (entries.length > 0) days[day] = sortEntries(entries.map((e) => ({ kind: e.kind, ...(e.hours !== undefined ? { hours: e.hours } : {}), publishTimeUtc: e.publishTimeUtc })));
  }
  if (refused.length > 0) return { ok: false, refused };
  return { ok: true, content: { days, horizonWeeks: t.horizonWeeks, displayTimeZone: t.displayTimeZone ?? null } };
}

const sortEntries = (entries: WeekTemplateEntry[]): WeekTemplateEntry[] =>
  [...entries].sort((a, b) => a.publishTimeUtc.localeCompare(b.publishTimeUtc) || a.kind.localeCompare(b.kind) || (a.hours ?? 0) - (b.hours ?? 0));

/** The canonical hash of a template's content (days in mon..sun order, entries sorted; the zone and horizon included). */
export function templateHashOf(content: WeekTemplateContent): string {
  const days = WEEK_TEMPLATE_DAYS.map((d) => [d, sortEntries(content.days[d] ?? []).map((e) => [e.kind, e.hours ?? null, e.publishTimeUtc])]);
  return createHash("sha256").update(JSON.stringify([WEEK_TEMPLATE_FORMAT, days, content.horizonWeeks, content.displayTimeZone ?? null])).digest("hex");
}

export const contentOfVersion = (v: Pick<PublishingPlanTemplateVersion, "days" | "horizonWeeks" | "displayTimeZone">): WeekTemplateContent => ({ days: v.days, horizonWeeks: v.horizonWeeks, displayTimeZone: v.displayTimeZone ?? null });

const byOrder = (a: { seq: number; at: string; id: string }, b: { seq: number; at: string; id: string }) => (a.seq ?? 0) - (b.seq ?? 0) || Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id);

/**
 * The template in force (ADR 0073 §1, AC-WT-02): the version named by the newest owner `approved` / `withdrawn` decision, when that is
 * `approved`, the version exists and its recomputed hash equals the decision's; else none (fail closed).
 */
export function templateInForce(snapshot: Pick<PublishingPlansSnapshot, "templateVersions" | "templateDecisions">): { version: PublishingPlanTemplateVersion; decision: PublishingPlanTemplateDecision } | null {
  const decisions = Object.values(snapshot.templateDecisions ?? {}).filter((d) => d && d.by === "owner" && (d.kind === "approved" || d.kind === "withdrawn"));
  const newest = decisions.sort(byOrder).at(-1);
  if (!newest || newest.kind !== "approved") return null;
  const version = snapshot.templateVersions?.[newest.versionId];
  if (!version || version.format !== WEEK_TEMPLATE_FORMAT) return null;
  if (templateHashOf(contentOfVersion(version)) !== version.contentHash || version.contentHash !== newest.contentHash) return null;
  return { version, decision: newest };
}

/** The newest Producer proposal the owner has not decided, newer than the last owner decision; else null (AC-WT-03). */
export function pendingProposal(snapshot: Pick<PublishingPlansSnapshot, "templateVersions" | "templateDecisions">): PublishingPlanTemplateVersion | null {
  const decisions = Object.values(snapshot.templateDecisions ?? {});
  const decided = new Set(decisions.map((d) => d.versionId));
  const lastDecision = decisions.sort(byOrder).at(-1);
  const proposal = Object.values(snapshot.templateVersions ?? {})
    .filter((v) => v.by === "producer" && !decided.has(v.id) && templateHashOf(contentOfVersion(v)) === v.contentHash)
    .sort(byOrder)
    .at(-1);
  if (!proposal) return null;
  return !lastDecision || byOrder(proposal, lastDecision) > 0 ? proposal : null;
}

/** The highest `seq` of the template maps, for the next record (a Lamport counter, as the slot decisions). */
export const nextTemplateSeq = (snapshot: Pick<PublishingPlansSnapshot, "templateVersions" | "templateDecisions">): number =>
  Math.max(0, ...Object.values(snapshot.templateVersions ?? {}).map((v) => v.seq ?? 0), ...Object.values(snapshot.templateDecisions ?? {}).map((d) => d.seq ?? 0)) + 1;

/** The template as the factory, the agents and the Producer read it (`week-template/1` with its version id). */
export type WeekTemplateView = { format: typeof WEEK_TEMPLATE_FORMAT; channelId: string; versionId: string; contentHash: string; horizonWeeks: number; displayTimeZone: string | null; days: WeekTemplateDays; by: "owner" | "producer"; at: string };

/** The one serializer of a version (the MCP answer and the factory's `week-template.json` use it, AC-WT-47). */
export function templateViewOf(channelId: string, version: PublishingPlanTemplateVersion): WeekTemplateView {
  const days: WeekTemplateDays = {};
  for (const d of WEEK_TEMPLATE_DAYS) if ((version.days[d] ?? []).length > 0) days[d] = sortEntries(version.days[d]!).map((e) => ({ kind: e.kind, ...(e.hours !== undefined ? { hours: e.hours } : {}), publishTimeUtc: e.publishTimeUtc }));
  return { format: WEEK_TEMPLATE_FORMAT, channelId, versionId: version.id, contentHash: version.contentHash, horizonWeeks: version.horizonWeeks, displayTimeZone: version.displayTimeZone ?? null, days, by: version.by, at: version.at };
}

/** Whether every entry is a long video with an hours bucket -- a music template (O7: «Собрать неделю по шаблону» is offered). */
export function isMusicTemplate(days: WeekTemplateDays): boolean {
  const entries = WEEK_TEMPLATE_DAYS.flatMap((d) => days[d] ?? []);
  return entries.length > 0 && entries.every((e) => e.kind === "long" && e.hours !== undefined);
}

// ---------------------------------------------------------------------------
// The matcher (ADR 0073 §2, plan §3.2)
// ---------------------------------------------------------------------------

const UTC_DAY: WeekTemplateDay[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** The template day of an instant: its UTC weekday (AC-WT-10). */
export const templateDayOf = (instant: Date): WeekTemplateDay => UTC_DAY[instant.getUTCDay()];
/** `HH:MM` of an instant in UTC. */
export const utcTimeOf = (instant: Date): string => instant.toISOString().slice(11, 16);

/** A slot as the matcher reads it. `durationSeconds` / `video`: from its package (null: no package yet). */
export type MatchSlot = { slotId: string; instant: Date; createdAt: string; vetoed: boolean; durationSeconds: number | null; video: string | null };

export type TemplatePosition = { date: string; day: WeekTemplateDay; index: number };

export type SlotMatch =
  | { state: "match"; position: TemplatePosition; entry: WeekTemplateEntry }
  /** On a template time, but no package yet: nothing to match on (no claim). */
  | { state: "on_template_awaiting_package"; position: TemplatePosition }
  /** Matches an entry whose position an earlier slot of the same kind holds (O4). */
  | { state: "position_taken"; position: TemplatePosition; heldBy: string }
  /** An `S<n>` longer than 180 s: neither kind (AC-WT-12). */
  | { state: "kind_unclear" }
  | { state: "off_template" };

/** The kind of a package (AC-WT-08/12): null when unclear (an `S` code over 180 s) or unknown (no readable duration). */
export function kindOf(durationSeconds: number | null, video: string | null): "long" | "short" | null {
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  if (durationSeconds <= TEMPLATE_MATCH_RULES.shortMaxSeconds) return "short";
  return video && /^S\d+$/.test(video) ? null : "long";
}

/** Whether a long video of `seconds` fits an entry (AC-WT-09): without `hours` any long; with it within ±10 %. */
export function fitsEntry(entry: WeekTemplateEntry, kind: "long" | "short", seconds: number): boolean {
  if (entry.kind !== kind) return false;
  if (entry.hours === undefined) return true;
  const target = entry.hours * 3600;
  return Math.abs(seconds - target) <= target * TEMPLATE_MATCH_RULES.hoursTolerance + 1e-9;
}

/**
 * Every slot's place in the template (pure). A vetoed slot claims nothing (its state is reported but never `match`). The live slots
 * at one instant are assigned to that instant's entries by priority -- the earliest `createdAt` (then the smaller `slotId`) first --
 * each preferring the most specific entry it fits (one with `hours` before one without, then the lower index), with augmenting paths
 * (review 2026-11-16 #6): a later slot may shift an earlier one to another entry it also fits, but never takes its position away, and
 * a free position is never reported as taken. A fitting slot left without an entry is `position_taken` (held by the slot on its
 * preferred entry).
 */
export function matchSlots(days: WeekTemplateDays, slots: readonly MatchSlot[]): Map<string, SlotMatch> {
  const out = new Map<string, SlotMatch>();
  type Candidate = { slot: MatchSlot; date: string; day: WeekTemplateDay; fits: Array<{ entry: WeekTemplateEntry; index: number }> };
  const byInstant = new Map<string, Candidate[]>();
  for (const slot of slots) {
    const day = templateDayOf(slot.instant);
    const time = utcTimeOf(slot.instant);
    const date = slot.instant.toISOString().slice(0, 10);
    const entries = (days[day] ?? []).map((entry, index) => ({ entry, index })).filter((e) => e.entry.publishTimeUtc === time);
    if (entries.length === 0) {
      out.set(slot.slotId, { state: "off_template" });
      continue;
    }
    if (slot.durationSeconds === null) {
      out.set(slot.slotId, { state: "on_template_awaiting_package", position: { date, day, index: entries[0].index } });
      continue;
    }
    const kind = kindOf(slot.durationSeconds, slot.video);
    if (kind === null) {
      out.set(slot.slotId, { state: "kind_unclear" });
      continue;
    }
    const fits = entries
      .filter((e) => fitsEntry(e.entry, kind, slot.durationSeconds!))
      .sort((a, b) => Number(a.entry.hours === undefined) - Number(b.entry.hours === undefined) || a.index - b.index);
    if (fits.length === 0 || slot.vetoed) {
      out.set(slot.slotId, { state: "off_template" });
      continue;
    }
    const key = `${date}|${time}`;
    byInstant.set(key, [...(byInstant.get(key) ?? []), { slot, date, day, fits }]);
  }
  for (const group of byInstant.values()) {
    const ordered = [...group].sort((a, b) => Date.parse(a.slot.createdAt) - Date.parse(b.slot.createdAt) || a.slot.slotId.localeCompare(b.slot.slotId));
    /** entry index -> the candidate holding it. */
    const holder = new Map<number, Candidate>();
    const assigned = new Map<Candidate, number>();
    const augment = (c: Candidate, seen: Set<number>): boolean => {
      for (const f of c.fits) {
        if (seen.has(f.index)) continue;
        seen.add(f.index);
        const other = holder.get(f.index);
        if (!other || augment(other, seen)) {
          holder.set(f.index, c);
          assigned.set(c, f.index);
          return true;
        }
      }
      return false;
    };
    for (const c of ordered) augment(c, new Set());
    for (const c of ordered) {
      const index = assigned.get(c);
      if (index !== undefined) {
        out.set(c.slot.slotId, { state: "match", position: { date: c.date, day: c.day, index }, entry: c.fits.find((f) => f.index === index)!.entry });
      } else {
        const preferred = c.fits[0];
        out.set(c.slot.slotId, { state: "position_taken", position: { date: c.date, day: c.day, index: preferred.index }, heldBy: holder.get(preferred.index)!.slot.slotId });
      }
    }
  }
  return out;
}

/** The template positions from `fromDate` to `toDate` (UTC dates, inclusive) -- for the screen's ghost cells. */
export function positionsBetween(days: WeekTemplateDays, fromDate: string, toDate: string): Array<TemplatePosition & { entry: WeekTemplateEntry; instantUtc: string }> {
  const out: Array<TemplatePosition & { entry: WeekTemplateEntry; instantUtc: string }> = [];
  for (let t = Date.parse(`${fromDate}T00:00:00Z`); t <= Date.parse(`${toDate}T00:00:00Z`); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const day = UTC_DAY[new Date(t).getUTCDay()];
    (days[day] ?? []).forEach((entry, index) => out.push({ date, day, index, entry, instantUtc: `${date}T${entry.publishTimeUtc}:00.000Z` }));
  }
  return out;
}
