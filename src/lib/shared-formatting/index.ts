// Standing owner instruction (2026-09-26, Telegram, verbatim: "Все даты в проекте должны
// следовать формату отображения DD.MM.YYYY") -- every date this app displays to the operator must
// use this one fixed format, never a locale-dependent one. Before this module existed, date
// displays across the app called `toLocaleDateString()`/`toLocaleString()` with no explicit
// locale, which renders differently depending on the viewer's own browser/OS locale -- the same
// class of bug this project already hit once for the Analytics settings time input (a native,
// locale-dependent widget showed "12.05" instead of "12:05" under a Finnish-locale browser, fixed
// by replacing the widget, not by picking a "better" locale). Both functions here render in the
// viewer's LOCAL time zone, matching the exact behavior of the `toLocaleString()`/
// `toLocaleDateString()` calls they replace -- only the display FORMAT changes, never which moment
// in time is shown.

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Renders a date-only value as "DD.MM.YYYY" in the viewer's local time zone. */
export function formatDisplayDate(value: string | number | Date): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** Renders a timestamp as "DD.MM.YYYY HH:MM" (24-hour) in the viewer's local time zone. */
export function formatDisplayDateTime(value: string | number | Date): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return `${formatDisplayDate(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// --- Editable fields: the reverse direction (owner instruction, 2026-09-26, Telegram: "Сделай
// модуль / шлюз которые перекодирует даты. И чтобы он работал в оба направления, как на чтение
// так и на запись") -- a form field can DISPLAY a date as DD.MM.YYYY while a downstream API (e.g.
// YouTube's) still receives its own expected wire format. These functions are the write-direction
// counterpart to the two above: parse exactly what a human typed back into a real calendar date,
// returning `null` (never a guessed/clamped value) for anything that isn't one -- including a
// syntactically-plausible but impossible date like "31.02.2026", which `new Date(...)` would
// otherwise silently roll over into March.

function parseCalendarComponents(day: number, month: number, year: number): Date | null {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/**
 * Parses a "DD.MM.YYYY" string into a wire-format ISO date. A date-only value has no meaningful
 * time-of-day, so this deliberately matches `new Date("YYYY-MM-DD").toISOString()`'s own existing
 * behavior (UTC midnight, per the ECMAScript date-only-string parsing rule) rather than the
 * viewer's local midnight -- the exact value a caller migrating off a native `<input type="date">`
 * (whose own value is already UTC-parsed the same way) would previously have produced.
 */
export function parseDisplayDate(text: string): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (parseCalendarComponents(day, month, year) === null) return null;
  return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

/**
 * Parses a "DD.MM.YYYY HH:MM" string into a wire-format ISO timestamp. Interprets the typed value
 * as the viewer's own LOCAL time before converting to UTC -- matching
 * `new Date("YYYY-MM-DDTHH:mm").toISOString()`'s existing behavior (a date-time string with no
 * explicit offset is parsed as local time), the exact value a caller migrating off a native
 * `<input type="datetime-local">` would previously have produced.
 */
export function parseDisplayDateTime(text: string): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour > 23 || minute > 59) return null;
  const date = parseCalendarComponents(day, month, year);
  if (date === null) return null;
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}
