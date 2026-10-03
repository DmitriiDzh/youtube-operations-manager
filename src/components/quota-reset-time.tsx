"use client";

import { formatDisplayDateTime, formatDisplayDateTimeInZone } from "@/lib/shared-formatting";
import { useUserTimezone } from "./use-user-timezone";

/** A quota reset moment shown in the operator's configured time zone (with its name), e.g. "04.10.2026 10:00 Europe/Helsinki". */
export function QuotaResetTime({ iso }: { iso: string }) {
  const timezone = useUserTimezone();
  if (!timezone) return <>{formatDisplayDateTime(iso)}</>;
  return <>{formatDisplayDateTimeInZone(iso, timezone)} {timezone}</>;
}
