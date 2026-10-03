/** "3 h 12 min" / "45 min" / "less than a minute" for a positive millisecond span; "now" when it is already past. */
export function formatTimeUntil(ms: number): string {
  if (ms <= 0) return "now";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "less than a minute";
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}
