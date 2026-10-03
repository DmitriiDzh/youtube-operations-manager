"use client";

import { useCallback, useEffect, useState } from "react";
import type { ConnectionHealth } from "@/lib/channel-connections/contracts";

/**
 * Health of every connected channel's stored Google grant (BL-115), fetched once on mount. `refetch({ force: true })`
 * bypasses the server's short cache (used after a failed channel load). A failed request leaves the previous value:
 * this is informational, it must never break the page it sits on.
 */
export function useConnectionHealth(enabled: boolean = true) {
  const [health, setHealth] = useState<ConnectionHealth[] | null>(null);

  const refetch = useCallback(async (options: { force?: boolean } = {}) => {
    try {
      const res = await fetch(`/api/channel-connections/health${options.force ? "?refresh=1" : ""}`);
      if (!res.ok) return;
      const data = (await res.json()) as { health: ConnectionHealth[] };
      setHealth(data.health);
    } catch {
      // keep the last known value
    }
  }, []);

  // `enabled` lets the dashboard wait for the session: a request before sign-in resolves would just be a 401.
  useEffect(() => {
    if (!enabled) return;
    queueMicrotask(() => {
      void refetch();
    });
  }, [enabled, refetch]);

  return { health, refetch };
}
