"use client";

export type GatewayTrafficWindowView = {
  category: string;
  totalAttempts: number;
  succeeded: number;
};

/**
 * Read-only rolling-24h traffic stats line for one gateway category (owner instruction,
 * 2026-09-22 -- "Сколько было попыток пройти через шлюз за последние сутки... Сколько попыток...
 * увенчались успехом"), rendered under that category's own `ToggleSwitch` in Settings. Always the
 * last 24 hours, never all-time (see `src/lib/db.ts`'s `getGatewayTrafficLast24h`).
 */
export function GatewayTrafficStats({
  window,
  size = "sm",
}: {
  window: GatewayTrafficWindowView | undefined;
  /** `"lg"` is the larger rendering used when this line sits alone in a Settings section's
   * right-hand column (`SettingsSectionRow`, owner instruction 2026-09-22: "статистику и прогресс
   * бар сделаем крупнее"). `"sm"` (default) is unchanged from before that instruction. */
  size?: "sm" | "lg";
}) {
  if (!window) return null;

  const textClass = size === "lg" ? "text-sm text-zinc-400" : "text-xs text-zinc-500";
  const valueClass = size === "lg" ? "font-medium text-zinc-100" : "text-zinc-300";

  return (
    <p className={`mt-2 ${textClass}`}>
      Attempts (24h): <span className={valueClass}>{window.totalAttempts.toLocaleString()}</span>
      {" — "}
      Succeeded: <span className={valueClass}>{window.succeeded.toLocaleString()}</span>
    </p>
  );
}
