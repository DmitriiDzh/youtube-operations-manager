/**
 * False divergences (owner, Telegram 2026-10-06, msgs 1758/1764): the automatic Market Intelligence
 * refresh writes transferred data, so it first lets device sync catch up with the other computer
 * (`syncBeforeBackgroundWrite`) and is skipped while that is not safe -- otherwise both computers
 * collect the same channels and end in a conflict. Composed here, in the route, so neither module
 * depends on the other (AGENTS.md §M); a device-sync failure never switches collection off.
 */
export async function collectAfterDeviceSync<T>(deps: {
  syncFirst: () => Promise<{ allowed: true } | { allowed: false; reason: string }>;
  collect: () => Promise<T>;
}): Promise<T | { skipped: true; reason: string }> {
  let verdict: { allowed: true } | { allowed: false; reason: string };
  try {
    verdict = await deps.syncFirst();
  } catch {
    verdict = { allowed: true };
  }
  if (!verdict.allowed) return { skipped: true, reason: verdict.reason };
  return deps.collect();
}
