"use client";

/**
 * Generic progress bar (owner instruction, 2026-09-22: "Прогресс бар так же может быть сделан
 * как отдельный 'модуль / ассет' для повторных использований в будущем"). Deliberately dumb --
 * no fetching, no domain knowledge of what `value`/`max` mean. Callers own formatting the label.
 */
export function ProgressBar({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="mt-2">
      {label && <p className="mb-1 text-xs text-zinc-500">{label}</p>}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className="h-full rounded-full bg-red-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
