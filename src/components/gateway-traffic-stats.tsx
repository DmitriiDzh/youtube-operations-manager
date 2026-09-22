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
export function GatewayTrafficStats({ window }: { window: GatewayTrafficWindowView | undefined }) {
  if (!window) return null;

  return (
    <p className="mt-2 text-xs text-zinc-500">
      Attempts (24h): <span className="text-zinc-300">{window.totalAttempts.toLocaleString()}</span>
      {" — "}
      Succeeded: <span className="text-zinc-300">{window.succeeded.toLocaleString()}</span>
    </p>
  );
}
