// Owner, Telegram 2026-10-07 (msgs 2011/2013): every conflict between the two computers is decided on one screen, made so the
// two versions are easy to compare -- human field names, values in words and units, and what differs highlighted. Pure helpers
// for that screen (conflict-center.tsx); nothing here fetches.

import type { Translate, UiTextKey } from "@/lib/ui-text";

/** Production → Setup fields (BL-150), in the words the Setup page uses. */
export const SETTING_LABELS: Record<string, { labelKey: UiTextKey; unit?: "usd" | "usd_per_hr" | "minutes" | "seconds" | "gb" }> = {
  datacenterId: { labelKey: "setupField.datacenterId" },
  gpuTypeId: { labelKey: "setupField.gpuTypeId" },
  cloudType: { labelKey: "setupField.cloudType" },
  networkVolumeId: { labelKey: "setupField.networkVolumeId" },
  templateId: { labelKey: "setupField.templateId" },
  maxUsdPerDay: { labelKey: "setupField.maxUsdPerDay", unit: "usd" },
  defaultMaxMinutes: { labelKey: "setupField.defaultMaxMinutes", unit: "minutes" },
  idleMinutes: { labelKey: "setupField.idleMinutes", unit: "minutes" },
  watchIntervalSeconds: { labelKey: "setupField.watchIntervalSeconds", unit: "seconds" },
  maxConcurrentSessions: { labelKey: "setupField.maxConcurrentSessions" },
  gpuFallbackIds: { labelKey: "setupField.gpuFallbackIds" },
  gpuMinVramGb: { labelKey: "setupField.gpuMinVramGb", unit: "gb" },
  gpuMaxPricePerHr: { labelKey: "setupField.gpuMaxPricePerHr", unit: "usd_per_hr" },
  capacityRetrySeconds: { labelKey: "setupField.capacityRetrySeconds", unit: "seconds" },
  capacityWaitMinutes: { labelKey: "setupField.capacityWaitMinutes", unit: "minutes" },
  factorySessionsEnabled: { labelKey: "setupField.factorySessionsEnabled" },
  factoryMaxUsdPerSession: { labelKey: "setupField.factoryMaxUsdPerSession", unit: "usd" },
  factoryMaxMinutesPerSession: { labelKey: "setupField.factoryMaxMinutesPerSession", unit: "minutes" },
  factoryMaxUsdPerDay: { labelKey: "setupField.factoryMaxUsdPerDay", unit: "usd" },
  factoryMaxUsdPerMonth: { labelKey: "setupField.factoryMaxUsdPerMonth", unit: "usd" },
  ownerReleaseWhenDone: { labelKey: "setupField.ownerReleaseWhenDone" },
  minCudaVersion: { labelKey: "setupField.minCudaVersion" },
};

export function settingLabel(t: Translate, field: string): string {
  const entry = SETTING_LABELS[field];
  return entry ? t(entry.labelKey) : field;
}

/** One value in words: units, On/Off, "not set". Lists are shown by `listDiff`. */
export function formatValue(t: Translate, value: unknown, unit?: (typeof SETTING_LABELS)[string]["unit"]): string {
  if (value === null || value === undefined || value === "") return t("value.notSet");
  if (typeof value === "boolean") return value ? t("value.on") : t("value.off");
  if (typeof value === "number") {
    switch (unit) {
      case "usd":
        return t("unit.usd", { value: String(value) });
      case "usd_per_hr":
        return t("unit.usdPerHour", { value: String(value) });
      case "minutes":
        return t("unit.minutes", { value: String(value) });
      case "seconds":
        return t("unit.seconds", { value: String(value) });
      case "gb":
        return t("unit.gb", { value: String(value) });
      default:
        return String(value);
    }
  }
  if (Array.isArray(value)) return value.length === 0 ? t("value.none") : value.map((v) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v))).join(", ");
  // An object (e.g. an AI connection's field) reads as its JSON, never as "[object Object]".
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export type DiffToken = { text: string; changed: boolean };

/**
 * Word-level difference of two texts: each side's words, marked where they are not part of the longest common sequence. Whitespace
 * is kept with its word so the text reads as written. Long texts fall back to "everything differs" (the LCS table is quadratic).
 */
export function wordDiff(a: string, b: string): { left: DiffToken[]; right: DiffToken[] } {
  const split = (s: string) => s.match(/\S+\s*|\s+/g) ?? [];
  const x = split(a);
  const y = split(b);
  if (x.length * y.length > 250_000) return { left: x.map((text) => ({ text, changed: true })), right: y.map((text) => ({ text, changed: true })) };
  const key = (t: string) => t.trim();
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = key(x[i]) === key(y[j]) ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const left: DiffToken[] = [];
  const right: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (key(x[i]) === key(y[j])) {
      left.push({ text: x[i++], changed: false });
      right.push({ text: y[j++], changed: false });
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) left.push({ text: x[i++], changed: true });
    else right.push({ text: y[j++], changed: true });
  }
  while (i < x.length) left.push({ text: x[i++], changed: true });
  while (j < y.length) right.push({ text: y[j++], changed: true });
  return { left, right };
}

/** An ordered list against another: each item marked where the other list does not have the same item at the same place. */
export function listDiff(a: readonly string[], b: readonly string[]): { left: DiffToken[]; right: DiffToken[] } {
  return {
    left: a.map((text, i) => ({ text, changed: b[i] !== text })),
    right: b.map((text, i) => ({ text, changed: a[i] !== text })),
  };
}
