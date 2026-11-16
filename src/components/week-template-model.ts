// BL-267 (WEEK_TEMPLATE_PLAN.md §3.9, ADR 0073 §7; owner msg 4572, O6): the pure helpers of «План» → «Шаблон недели» and the week's
// free template positions. Client-safe (no node imports): the template's rules themselves are the publishing-plans module's.

export const TEMPLATE_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type TemplateDay = (typeof TEMPLATE_DAYS)[number];
export type TemplateEntryDto = { kind: "long" | "short"; hours?: number; publishTimeUtc: string };
export type TemplateDto = {
  format: "week-template/1";
  channelId: string;
  versionId?: string;
  contentHash?: string;
  horizonWeeks: number;
  displayTimeZone: string | null;
  days: Partial<Record<TemplateDay, TemplateEntryDto[]>>;
  by?: "owner" | "producer";
  at?: string;
};
export type TemplateAnswerDto = { template: TemplateDto | null; proposal: TemplateDto | null };

const UTC_DAY: TemplateDay[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** A blank template for a channel (two weeks ahead, no entries). */
export const emptyTemplate = (channelId: string, displayTimeZone: string | null = null): TemplateDto => ({ format: "week-template/1", channelId, horizonWeeks: 2, displayTimeZone, days: {} });

/** `HH:MM` 00:00..23:55 with minutes a multiple of 5 (the contract's rule), else null. */
export function parseTemplateTime(value: string): string | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59 || min % 5 !== 0) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** The time of an instant in a zone (`HH:MM`) and its date (`YYYY-MM-DD`); the browser's zone when `zone` is null. */
export function partsIn(iso: string, zone: string | null): { ymd: string; time: string } {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: zone ?? undefined, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/**
 * O6 (AC-WT-43): an instant as the owner reads it -- his zone's time, UTC beside it, and whether his date differs from the UTC one
 * (`dayShift`: -1 / 0 / +1). 2026-11-23T15:00Z in Europe/Moscow -> { local 18:00, utc 15:00, dayShift 0 }; in Asia/Tokyo -> 00:00, +1.
 */
export function localAndUtc(iso: string, ownerZone: string | null): { local: string; utc: string; dayShift: number; localYmd: string } {
  const local = partsIn(iso, ownerZone);
  const utcYmd = iso.slice(0, 10);
  const utc = new Date(iso).toISOString().slice(11, 16);
  const dayShift = local.ymd === utcYmd ? 0 : local.ymd > utcYmd ? 1 : -1;
  return { local: local.time, utc, dayShift, localYmd: local.ymd };
}

/** The template entries of one template day, as the owner reads them: UTC time, and his own for the next date of that weekday. */
export function entryInstant(day: TemplateDay, time: string, nowMs: number): string {
  const today = new Date(nowMs);
  const target = TEMPLATE_DAYS.indexOf(day);
  const current = (today.getUTCDay() + 6) % 7;
  const ahead = (target - current + 7) % 7;
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + ahead)).toISOString().slice(0, 10);
  return `${date}T${time}:00.000Z`;
}

/** The template positions on the given UTC dates (date, entry index in the time-sorted day, the entry, its instant). */
export function positionsOn(days: TemplateDto["days"], utcDates: readonly string[]): Array<{ date: string; day: TemplateDay; index: number; entry: TemplateEntryDto; instantUtc: string }> {
  const out: Array<{ date: string; day: TemplateDay; index: number; entry: TemplateEntryDto; instantUtc: string }> = [];
  for (const date of utcDates) {
    const day = UTC_DAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
    sortEntries(days[day] ?? []).forEach((entry, index) => out.push({ date, day, index, entry, instantUtc: `${date}T${entry.publishTimeUtc}:00.000Z` }));
  }
  return out;
}

export const sortEntries = (entries: readonly TemplateEntryDto[]): TemplateEntryDto[] =>
  [...entries].sort((a, b) => a.publishTimeUtc.localeCompare(b.publishTimeUtc) || a.kind.localeCompare(b.kind) || (a.hours ?? 0) - (b.hours ?? 0));

/** The UTC dates a plan week covers: its local Monday's start to its Sunday's end can touch eight UTC dates. */
export function utcDatesOfWeek(slotsUtc: readonly string[], weekStart: string): string[] {
  const first = new Date(Date.parse(`${weekStart}T00:00:00Z`) - 86_400_000);
  return Array.from({ length: 9 }, (_, i) => new Date(first.getTime() + i * 86_400_000).toISOString().slice(0, 10)).filter((d) => d >= weekStart || slotsUtc.some((s) => s.startsWith(d)));
}

/** AC-WT-30: the positions of a week that no live slot holds (ghost cells), from now on. */
export function freePositions(
  days: TemplateDto["days"],
  weekStart: string,
  slots: ReadonlyArray<{ vetoed: unknown; dating?: { position?: { date: string; index: number } } }>,
  nowMs: number
): Array<{ date: string; day: TemplateDay; index: number; entry: TemplateEntryDto; instantUtc: string }> {
  const dates = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${weekStart}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  const held = new Set(slots.filter((s) => !s.vetoed && s.dating?.position).map((s) => `${s.dating!.position!.date}|${s.dating!.position!.index}`));
  return positionsOn(days, dates).filter((p) => !held.has(`${p.date}|${p.index}`) && Date.parse(p.instantUtc) > nowMs);
}

/** Per day, what an edit changes (`before` -> `after`, each a list of `kind hours time`), only the days that differ. */
export function templateDiff(before: TemplateDto | null, after: TemplateDto): Array<{ day: TemplateDay; before: string[]; after: string[] }> {
  const line = (e: TemplateEntryDto) => `${e.kind}${e.hours !== undefined ? ` ${e.hours}h` : ""} ${e.publishTimeUtc}`;
  return TEMPLATE_DAYS.flatMap((day) => {
    const b = sortEntries(before?.days[day] ?? []).map(line);
    const a = sortEntries(after.days[day] ?? []).map(line);
    return b.join("|") === a.join("|") ? [] : [{ day, before: b, after: a }];
  });
}

/** O7: a music template -- every entry a long video with an hours bucket. */
export function isMusicTemplateDto(t: TemplateDto | null): boolean {
  const entries = t ? TEMPLATE_DAYS.flatMap((d) => t.days[d] ?? []) : [];
  return entries.length > 0 && entries.every((e) => e.kind === "long" && e.hours !== undefined);
}
