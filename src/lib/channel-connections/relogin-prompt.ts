import type { ConnectionHealth } from "./contracts";

export type ReloginPrompt =
  | { mode: "none"; rows: [] }
  /** At least one account must sign in again: the dialog cannot be dismissed. */
  | { mode: "blocking"; rows: ConnectionHealth[] }
  /** Only grants that are about to expire: the dialog offers "Later". */
  | { mode: "soft"; rows: ConnectionHealth[] };

/**
 * What the dashboard-load popup shows (BL-115, owner decisions 2026-10-03): ONE popup listing every account that
 * needs a new login (the user picks which to sign in first); a hard stop only while some account is
 * `reauth_required`; a dismissable one for `expiring_soon`. `unknown` and `ok` never produce a popup.
 * Accounts that need a login now come before those merely expiring.
 */
export function planReloginPrompt(health: readonly ConnectionHealth[], laterChosen: boolean): ReloginPrompt {
  const dead = health.filter((h) => h.state === "reauth_required");
  const soon = health.filter((h) => h.state === "expiring_soon");
  // BL-126: the Google Cloud grant only feeds quota statistics, so it is listed (and can be reconnected here) but never
  // blocks the app: a dead one alone gives the dismissable dialog. A dead CHANNEL login keeps the hard stop.
  const deadChannels = dead.filter((h) => h.kind !== "cloud");
  if (deadChannels.length > 0) return { mode: "blocking", rows: [...dead, ...soon] };
  const attention = [...dead, ...soon];
  if (attention.length > 0 && !laterChosen) return { mode: "soft", rows: attention };
  return { mode: "none", rows: [] };
}
