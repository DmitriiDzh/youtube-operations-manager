import { createTranslator, type Translate } from "@/lib/ui-text";

const EN = createTranslator("en");

/**
 * "3 h 12 min" / "45 min" / "less than a minute" for a positive millisecond span; "now" when it is already past.
 * BL-152: in `t`'s language; English by default.
 */
export function formatTimeUntil(ms: number, t: Translate = EN): string {
  if (ms <= 0) return t("timeUntil.now");
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return t("timeUntil.lessThanMinute");
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? t("timeUntil.hoursMinutes", { h: String(hours), m: String(minutes) }) : t("timeUntil.minutes", { m: String(minutes) });
}
