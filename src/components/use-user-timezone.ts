"use client";

import { useEffect, useState } from "react";

// The operator's own time zone: Settings → "Your time zone" (`userTimezone`). The quota widgets show the reset time in it, and
// `UtcTimeField` the local time next to a UTC time. Cached for the page's lifetime so the widgets on one screen share a single
// /api/settings read.
let cached: Promise<string | null> | null = null;

function loadUserTimezone(): Promise<string | null> {
  cached ??= fetch("/api/settings")
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { userTimezone?: string | null } | null) => data?.userTimezone ?? null)
    .catch(() => null);
  return cached;
}

/** The configured time zone, or null until loaded / when unavailable (callers then show the browser's local time). */
export function useUserTimezone(): string | null {
  return useUserTimezoneStatus().timezone;
}

/**
 * Owner TG 4784 review (item 5): the zone and whether its read has finished -- `resolved: false` while loading, so a caller can
 * tell "not known yet" from "not set" (both `timezone: null`).
 */
export function useUserTimezoneStatus(): { timezone: string | null; resolved: boolean } {
  const [status, setStatus] = useState<{ timezone: string | null; resolved: boolean }>({ timezone: null, resolved: false });
  useEffect(() => {
    let alive = true;
    void loadUserTimezone().then((tz) => {
      if (alive) setStatus({ timezone: tz, resolved: true });
    });
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

/** Called after the operator saves a new timezone, so quota widgets pick it up without a reload. */
export function resetUserTimezoneCache(): void {
  cached = null;
}
