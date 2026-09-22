"use client";

/**
 * Generic progress bar (owner instruction, 2026-09-22: "Прогресс бар так же может быть сделан
 * как отдельный 'модуль / ассет' для повторных использований в будущем"). Deliberately dumb --
 * no fetching, no domain knowledge of what `value`/`max` mean. Callers own formatting the label.
 */
export function ProgressBar({
  value,
  max,
  label,
  color = "red",
}: {
  value: number;
  max: number;
  label?: string;
  /** Defaults to the app's red accent (matches `ToggleSwitch`). `"indigo"` is for a bar that
   * represents something structurally different from the default red ones on the same page
   * (owner instruction, 2026-09-22, for the per-minute Cloud Monitoring quota bar: "можем и
   * цвет ему дать фиолетовый, так же как у кнопки соединения с Cloud" -- the same
   * `bg-indigo-600` already used by "Connect Google Cloud" / "Save / Apply"). */
  color?: "red" | "indigo";
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const barColorClass = color === "indigo" ? "bg-indigo-600" : "bg-red-600";
  return (
    <div className="mt-2">
      {label && <p className="mb-1 text-xs text-zinc-500">{label}</p>}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${barColorClass} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
