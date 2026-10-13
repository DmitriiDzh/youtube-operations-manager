import { isValidLocalTimeOfDay } from "@/lib/analytics/staleness";

/**
 * BL-181 (FO-REQ-0020 §2.3): the evening re-collect boundary in a Settings save. `""` turns it off; otherwise it is "HH:MM" and later
 * than the daily boundary -- the one this same save sets, or the stored one. A pair the evening run would ignore is refused, also
 * when only the daily boundary moves past the stored evening one. `eveningToSet` is present only when the save names the evening
 * field (null or absent = leave it as it is).
 */
export function checkAnalyticsBoundaries(args: {
  eveningInput: unknown;
  morningToSet: string | undefined;
  currentEvening: string;
  currentMorning: string;
}): { ok: true; eveningToSet?: string } | { ok: false; message: string } {
  const eveningGiven = args.eveningInput !== undefined && args.eveningInput !== null;
  if (!eveningGiven && args.morningToSet === undefined) return { ok: true };
  const evening = eveningGiven ? args.eveningInput : args.currentEvening;
  if (typeof evening !== "string" || (evening !== "" && !isValidLocalTimeOfDay(evening))) {
    return { ok: false, message: 'analyticsEveningLocalTime must be "" (off) or a valid 24-hour HH:MM string' };
  }
  const morning = args.morningToSet ?? args.currentMorning;
  if (evening !== "" && evening <= morning) {
    return { ok: false, message: "analyticsEveningLocalTime must be later than analyticsSyncLocalTime (the daily boundary)" };
  }
  return eveningGiven ? { ok: true, eveningToSet: evening } : { ok: true };
}
