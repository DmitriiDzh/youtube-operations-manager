import { isValidLocalTimeOfDay } from "@/lib/zoned-time";

/**
 * BL-181 (FO-REQ-0020 §2.3): the evening re-collect boundary in a Settings save. `""` turns it off; otherwise it is "HH:MM" and later
 * than the daily boundary -- the one this same save sets, or the stored one. Both are UTC times since 2026-10-13 (owner, msgs
 * 2725/2727), and the collection computes its day in UTC, so "later" is a comparison within one UTC day. A pair the evening run would ignore is refused, also
 * when only the daily boundary moves past the stored evening one. `eveningToSet` is present only when the save names the evening
 * field (null or absent = leave it as it is).
 */
export function checkAnalyticsBoundaries(args: {
  eveningInput: unknown;
  dailyToSet: string | undefined;
  currentEvening: string;
  currentDaily: string;
}): { ok: true; eveningToSet?: string } | { ok: false; message: string } {
  const eveningGiven = args.eveningInput !== undefined && args.eveningInput !== null;
  if (!eveningGiven && args.dailyToSet === undefined) return { ok: true };
  const evening = eveningGiven ? args.eveningInput : args.currentEvening;
  if (typeof evening !== "string" || (evening !== "" && !isValidLocalTimeOfDay(evening))) {
    return { ok: false, message: 'analyticsEveningUtcTime must be "" (off) or a valid 24-hour HH:MM string (UTC)' };
  }
  const daily = args.dailyToSet ?? args.currentDaily;
  if (evening !== "" && evening <= daily) {
    return { ok: false, message: "analyticsEveningUtcTime must be later than analyticsSyncUtcTime (the daily boundary, both UTC)" };
  }
  return eveningGiven ? { ok: true, eveningToSet: evening } : { ok: true };
}
