"use client";

export type GatewayTrafficCounterView = {
  category: string;
  allowedCount: number;
  blockedCount: number;
  lastAllowedAt: number | null;
  lastBlockedAt: number | null;
};

function formatWhen(unixSeconds: number | null): string {
  if (unixSeconds === null) return "never";
  return new Date(unixSeconds * 1000).toLocaleString();
}

/**
 * Read-only traffic stats line for one gateway category (owner instruction, 2026-09-22 --
 * "сколько запросов было сделано / сколько прошло сквозь шлюз"), rendered under that category's
 * own `ToggleSwitch` in Settings. `blockedCount`/`lastBlockedAt` are omitted for `mcp_tool_calls`
 * specifically (pass `hideBlocked`) -- there is no meaningful "blocked call" there, only an
 * absent tool (see `src/lib/db.ts`'s `gatewayTrafficCounters` doc comment).
 */
export function GatewayTrafficStats({
  counter,
  hideBlocked = false,
  allowedLabel = "Allowed",
}: {
  counter: GatewayTrafficCounterView | undefined;
  hideBlocked?: boolean;
  allowedLabel?: string;
}) {
  if (!counter) return null;

  return (
    <p className="mt-2 text-xs text-zinc-500">
      {allowedLabel}: <span className="text-zinc-300">{counter.allowedCount.toLocaleString()}</span>
      {" "}(last: {formatWhen(counter.lastAllowedAt)})
      {!hideBlocked && (
        <>
          {" — "}Blocked: <span className="text-zinc-300">{counter.blockedCount.toLocaleString()}</span>
          {" "}(last: {formatWhen(counter.lastBlockedAt)})
        </>
      )}
    </p>
  );
}
