import {
  REFRESH_TOKEN_MAX_AGE_DAYS,
  REFRESH_TOKEN_WARN_AGE_DAYS,
  type ConnectionHealthState,
  type HealthProbe,
} from "./contracts";

const DAY_MS = 86_400_000;

export type HealthVerdict = { state: ConnectionHealthState; ageDays: number | null; daysLeft: number | null };

/**
 * Pure verdict for one stored connection (BL-115). Rules, from the requirement (Google expires a Testing-status
 * refresh token 7 days after issue; the owner asked to be prompted before that):
 * - a real check that said `invalid_grant` is final: `reauth_required`, whatever the age;
 * - a passing real check proves the grant works now: age >= 7 days then means the 7-day limit is not in force,
 *   so `ok`; age in [6, 7) days is `expiring_soon`; younger is `ok`; an unknown age is `ok`;
 * - without a usable real check (`error`/`not_run`), the age decides: >= 7 days `reauth_required`,
 *   >= 6 days `expiring_soon`, younger `ok`, unknown age `unknown`.
 */
export function classifyConnectionHealth(args: {
  refreshTokenIssuedAt: Date | null;
  probe: HealthProbe;
  now: Date;
}): HealthVerdict {
  const ageMs = args.refreshTokenIssuedAt ? args.now.getTime() - args.refreshTokenIssuedAt.getTime() : null;
  // A clock that is behind the issue date never produces a negative age.
  const ageDays = ageMs === null ? null : Math.max(0, Math.floor(ageMs / DAY_MS));
  const ageKnown = ageMs !== null;
  const daysLeft = ageKnown ? Math.max(0, Math.ceil((REFRESH_TOKEN_MAX_AGE_DAYS * DAY_MS - ageMs) / DAY_MS)) : null;

  if (args.probe === "invalid_grant") return { state: "reauth_required", ageDays, daysLeft: 0 };

  const warn = ageKnown && ageMs >= REFRESH_TOKEN_WARN_AGE_DAYS * DAY_MS;
  const expired = ageKnown && ageMs >= REFRESH_TOKEN_MAX_AGE_DAYS * DAY_MS;

  if (args.probe === "ok") {
    if (expired) return { state: "ok", ageDays, daysLeft: null };
    return { state: warn ? "expiring_soon" : "ok", ageDays, daysLeft };
  }

  if (!ageKnown) return { state: "unknown", ageDays: null, daysLeft: null };
  if (expired) return { state: "reauth_required", ageDays, daysLeft: 0 };
  return { state: warn ? "expiring_soon" : "ok", ageDays, daysLeft };
}
