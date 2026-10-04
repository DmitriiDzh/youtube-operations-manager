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
  size = "sm",
  underlayValue,
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
  /** `"lg"` is the larger rendering used when this bar sits alone in a Settings section's right-
   * hand column (`SettingsSectionRow`, owner instruction 2026-09-22: "статистику и прогресс бар
   * сделаем крупнее") -- taller track, larger label text. `"sm"` (default) is unchanged from
   * before that instruction. */
  size?: "sm" | "lg";
  /** A second, dimmer layer drawn UNDER the main bar (owner idea, 2026-10-04): our own estimate that the real figure
   * (`value`) catches up with. Shown only when given; the main bar always sits on top of it. */
  underlayValue?: number;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const underlayPct = underlayValue === undefined || max <= 0 ? null : Math.min(100, Math.max(0, (underlayValue / max) * 100));
  const barColorClass = color === "indigo" ? "bg-indigo-600" : "bg-red-600";
  const trackHeightClass = size === "lg" ? "h-2.5" : "h-1.5";
  const labelClass = size === "lg" ? "text-sm text-zinc-300" : "text-xs text-zinc-500";
  return (
    <div className="mt-2">
      {label && <p className={`mb-1 ${labelClass}`}>{label}</p>}
      <div className={`relative ${trackHeightClass} w-full overflow-hidden rounded-full bg-zinc-800`}>
        {underlayPct !== null && (
          <div
            data-testid="progress-underlay"
            className="absolute inset-y-0 left-0 rounded-full bg-red-900/60 transition-all"
            style={{ width: `${underlayPct}%` }}
          />
        )}
        <div className={`absolute inset-y-0 left-0 rounded-full ${barColorClass} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
