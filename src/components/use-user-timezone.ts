"use client";

import { useEffect, useState } from "react";

// The operator's own time zone is the Analytics "Timezone (IANA name)" setting. Cached for the page's lifetime so the
// several quota widgets on one screen share a single /api/settings read.
let cached: Promise<string | null> | null = null;

function loadUserTimezone(): Promise<string | null> {
  cached ??= fetch("/api/settings")
    .then((res) => (res.ok ? res.json() : null))
    .then((data: { analyticsSyncTimezone?: string | null } | null) => data?.analyticsSyncTimezone ?? null)
    .catch(() => null);
  return cached;
}

/** The configured time zone, or null until loaded / when unavailable (callers then show the browser's local time). */
export function useUserTimezone(): string | null {
  const [timezone, setTimezone] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void loadUserTimezone().then((tz) => {
      if (alive) setTimezone(tz);
    });
    return () => {
      alive = false;
    };
  }, []);
  return timezone;
}

/** Called after the operator saves a new timezone, so quota widgets pick it up without a reload. */
export function resetUserTimezoneCache(): void {
  cached = null;
}
