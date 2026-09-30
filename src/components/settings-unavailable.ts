/**
 * Architecture-audit review (H2): `GET /api/settings` now returns 200 even when some of its reads
 * failed -- those fields are `null` and named in `unavailable`. A Settings card must not render such
 * a `null` as if it were the real value (e.g. a quota budget of "0 = off", an empty workspace path)
 * and must not let Save write it back. A card whose own field is unavailable behaves as before H2:
 * it shows its load failure instead of an editable form.
 */
export function ownSettingsUnavailable(data: unknown, ownKeys: readonly string[]): boolean {
  const unavailable = (data as { unavailable?: unknown })?.unavailable;
  return Array.isArray(unavailable) && unavailable.some((key) => ownKeys.includes(String(key)));
}
