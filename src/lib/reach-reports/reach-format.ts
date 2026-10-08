import { formatNumber, type UiLanguage } from "@/lib/ui-text";

/**
 * Display helpers for Reach numbers. **CTR scale is an assumption until the first real report is read
 * (BL-114):** `video_thumbnail_impressions_ctr` is treated as a RATIO (0.052 = 5.2%). If real data shows
 * the report already uses percent, this is the single place to change.
 * BL-152: numbers in the interface language's marks ("5.20%" / "5,20 %"); English by default.
 */
export function formatCtr(ctr: number | null, language: UiLanguage = "en"): string {
  if (ctr === null) return "—";
  return formatNumber(language, ctr, { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatImpressions(value: number, language: UiLanguage = "en"): string {
  return formatNumber(language, value);
}
