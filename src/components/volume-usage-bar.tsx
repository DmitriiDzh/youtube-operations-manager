"use client";

import { useState } from "react";
import type { MediaVolumeUsage } from "@/lib/media-generation/contracts";
import type { Translate } from "@/lib/ui-text";
import { useUiText } from "./ui-text-provider";

// BL-136 (owner, Telegram 2026-10-06, msg 1709): a space bar at the top of Production → Models -- how much is rented, how much
// is used, and how much each model takes. One horizontal stacked bar (part-to-whole) against the rented size: the largest
// models get their own segment, the rest fold into "Other models", non-model files (exchange/, pull staging and verdicts)
// are one segment, the unfilled track is free space. RunPod does not report used space, so "used" is the S3 sum.

export const GIB = 1024 ** 3;
/** How many models get their own colored segment; the rest fold into "Other models" (dataviz: never generate a 6th hue). */
export const MAX_MODEL_SEGMENTS = 5;
/** Categorical slots 1-5 of the dataviz reference palette, dark steps (the app is dark), validated on #18181b. */
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];
const OTHER_MODELS = "#a1a1aa";
const OTHER_FILES = "#71717a";

export type UsageSegment = { id: string; label: string; bytes: number; color: string; kind: "model" | "other-models" | "other-files" };
export type UsageBreakdown = {
  rentedBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** Used beyond the rented size (should not happen; shown, never hidden). */
  overBytes: number;
  segments: UsageSegment[];
  /** Whether "used" is the whole-volume S3 sum (true) or only the model files (the usage listing failed). */
  complete: boolean;
};

/**
 * Splits the volume into bar segments. The largest MAX_MODEL_SEGMENTS models (by size, then key) get their own segment; colors
 * go to those in key order, so a model keeps its color while the shown set is unchanged. Without `usage` only the model files
 * are known: "used" is their sum and the breakdown is marked incomplete.
 */
export function volumeUsageBreakdown(input: {
  rentedGb: number;
  models: Array<{ key: string; name: string; bytes: number }>;
  usage: MediaVolumeUsage | null;
}): UsageBreakdown {
  const rentedBytes = Math.max(0, input.rentedGb) * GIB;
  const bySize = [...input.models].sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));
  const shown = bySize.slice(0, MAX_MODEL_SEGMENTS).filter((m) => m.bytes > 0);
  const shownBytes = shown.reduce((sum, m) => sum + m.bytes, 0);
  const listedModelBytes = input.models.reduce((sum, m) => sum + m.bytes, 0);
  const modelsBytes = input.usage ? Math.max(input.usage.modelsBytes, listedModelBytes) : listedModelBytes;
  const otherFilesBytes = input.usage ? input.usage.exchangeBytes + input.usage.otherBytes : 0;
  const segments: UsageSegment[] = [...shown]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((m, i) => ({ id: m.key, label: m.name, bytes: m.bytes, color: SERIES[i], kind: "model" as const }));
  const otherModels = modelsBytes - shownBytes;
  // BL-152: the folded segments' labels are shown through `segmentLabel` (translated by kind); these stay as their English names.
  // ui-text-ignore: shown via segmentLabel, by kind
  if (otherModels > 0) segments.push({ id: "other-models", label: "Other models", bytes: otherModels, color: OTHER_MODELS, kind: "other-models" });
  // ui-text-ignore: shown via segmentLabel, by kind
  if (otherFilesBytes > 0) segments.push({ id: "other-files", label: "Exchange and service files", bytes: otherFilesBytes, color: OTHER_FILES, kind: "other-files" });
  const usedBytes = modelsBytes + otherFilesBytes;
  return {
    rentedBytes,
    usedBytes,
    freeBytes: Math.max(0, rentedBytes - usedBytes),
    overBytes: Math.max(0, usedBytes - rentedBytes),
    segments,
    complete: input.usage !== null,
  };
}

type NumberFormat = (value: number, options?: Intl.NumberFormatOptions) => string;

export function formatBytes(t: Translate, formatNumber: NumberFormat, bytes: number): string {
  const fixed = (value: number, digits: number) => formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (bytes >= GIB) return t("unit.gb", { value: fixed(bytes / GIB, bytes >= 100 * GIB ? 0 : 1) });
  if (bytes >= 1024 ** 2) return t("volume.mb", { value: fixed(bytes / 1024 ** 2, 0) });
  return t("volume.bytes", { value: fixed(bytes, 0) });
}

/** A segment's name: a model's own file name, or the folded segments' names in the interface language. */
function segmentLabel(t: Translate, segment: UsageSegment): string {
  if (segment.kind === "other-models") return t("volume.otherModels");
  if (segment.kind === "other-files") return t("volume.otherFiles");
  return segment.label;
}

export function VolumeUsageBar({ breakdown }: { breakdown: UsageBreakdown }) {
  const { t, formatNumber } = useUiText();
  const size = (bytes: number) => formatBytes(t, formatNumber, bytes);
  const [hovered, setHovered] = useState<string | null>(null);
  const scale = Math.max(breakdown.rentedBytes, breakdown.usedBytes) || 1;
  const pct = (bytes: number) => (bytes / scale) * 100;
  const usedPct = breakdown.rentedBytes > 0 ? Math.round((breakdown.usedBytes / breakdown.rentedBytes) * 100) : null;
  const focus = breakdown.segments.find((s) => s.id === hovered) ?? null;

  return (
    <div className="space-y-2" aria-label={t("volume.label")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="text-zinc-200">
          {/* The used size is emphasized wherever the sentence puts it: the text is split at its {used} placeholder. */}
          {(usedPct !== null ? t("volume.usedOfRentedPercent", { rented: size(breakdown.rentedBytes), percent: usedPct }) : t("volume.usedOfRented", { rented: size(breakdown.rentedBytes) }))
            .split("{used}")
            .map((part, i) => (
              <span key={i}>
                {i > 0 && <span className="text-base font-semibold text-white">{size(breakdown.usedBytes)}</span>}
                {part}
              </span>
            ))}
        </span>
        <span className="text-zinc-400">{breakdown.overBytes > 0 ? t("volume.over", { size: size(breakdown.overBytes) }) : t("volume.free", { size: size(breakdown.freeBytes) })}</span>
      </div>
      {/* The track is the rented size; segments are separated by a 2px gap in the surface color. */}
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded bg-zinc-800" role="img" aria-label={t("volume.barLabel", { used: size(breakdown.usedBytes), rented: size(breakdown.rentedBytes) })}>
        {breakdown.segments.map((s) => (
          <div
            key={s.id}
            className="h-full shrink-0 transition-opacity"
            style={{ width: `${pct(s.bytes)}%`, minWidth: s.bytes > 0 ? 2 : 0, backgroundColor: s.color, opacity: hovered && hovered !== s.id ? 0.45 : 1 }}
            onMouseEnter={() => setHovered(s.id)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
      </div>
      <p className="h-4 text-xs text-zinc-300">{focus ? t("volume.focus", { label: segmentLabel(t, focus), size: size(focus.bytes), percent: Math.round(pct(focus.bytes)) }) : ""}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-400">
        {breakdown.segments.map((s) => (
          <li key={s.id} className="flex items-center gap-1.5" onMouseEnter={() => setHovered(s.id)} onMouseLeave={() => setHovered(null)}>
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: s.color }} />
            <span className="max-w-[16rem] truncate text-zinc-300" title={segmentLabel(t, s)}>
              {segmentLabel(t, s)}
            </span>
            <span>{size(s.bytes)}</span>
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm border border-zinc-600 bg-zinc-800" />
          <span className="text-zinc-300">{t("volume.freeLegend")}</span>
          <span>{size(breakdown.freeBytes)}</span>
        </li>
      </ul>
      {!breakdown.complete && <p className="text-xs text-amber-400">{t("volume.incomplete")}</p>}
    </div>
  );
}
