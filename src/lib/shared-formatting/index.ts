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
