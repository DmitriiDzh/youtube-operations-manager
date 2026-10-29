import type { Translate } from "@/lib/ui-text";

// BL-237: a size in GB as the app shows it -- 10^9 bytes, one decimal ("12.3 GB") -- shared by the «Диск» card and the bell.
const GB = 1_000_000_000;

export function gbLabel(t: Translate, bytes: number): string {
  return t("unit.gb", { value: (bytes / GB).toFixed(1) });
}
