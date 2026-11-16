// BL-263 (ADR 0071; docs/roadmap/plans/SHORT_VIDEO_CODE_PLAN.md §3; AGENTS.md §M): THE rules of a video code -- `V<n>` (long and
// legacy videos, the next one given by YTM) and `S<n>` (WWE Shorts, the number given by the factory). Every module that checks,
// parses or sorts a code uses this one module; nothing else writes a code regex. Pure and dependency-free, so `sync-gateway` and a
// client component can import it too.

/** The series a code can belong to, in display order (V before S). */
export const VIDEO_SERIES = ["V", "S"] as const;
export type VideoSeries = (typeof VIDEO_SERIES)[number];

/** A strict code: a series letter, then a number without a leading zero, at most six digits (`V1`, `V49`, `S14`, `S999999`). */
export const VIDEO_CODE_PATTERN = /^(V|S)[1-9][0-9]{0,5}$/;
/** The strict S code alone (S never had a legacy spelling, so it is strict everywhere, readers included). */
export const STRICT_S_CODE_PATTERN = /^S[1-9][0-9]{0,5}$/;
/** The strict V code alone (today's input rule for V). */
export const STRICT_V_CODE_PATTERN = /^V[1-9][0-9]{0,5}$/;

/** Every input (MCP, routes, reservations, recode) and every new contract: a strict V or S code. */
export function isVideoCode(value: string): boolean {
  return VIDEO_CODE_PATTERN.test(value);
}

export function isStrictSCode(value: string): boolean {
  return STRICT_S_CODE_PATTERN.test(value);
}

export function isStrictVCode(value: string): boolean {
  return STRICT_V_CODE_PATTERN.test(value);
}

/** The lenient V the file readers accept today (`V\d+`: `V07`, `V0` included) -- kept so no existing package changes meaning. */
export function isLegacyVCode(value: string): boolean {
  return /^V\d+$/.test(value);
}

/** The V the uploads report accepts today (`V\d{1,6}`). */
export function isReportVCode(value: string): boolean {
  return /^V\d{1,6}$/.test(value);
}

/** A file reader's rule: its current lenient V (`V\d+`) or a strict S. */
export function isReadableVideoCode(value: string): boolean {
  return isLegacyVCode(value) || isStrictSCode(value);
}

/**
 * The regex source of a readable code inside a longer name (`V\d+` or a strict S), for the readers that match a file or folder
 * name (`V14_release.json`, `0928 S14 Short`). Wrapped in a non-capturing group; the caller anchors it.
 */
export const READABLE_VIDEO_CODE_SOURCE = "(?:V\\d+|S[1-9][0-9]{0,5})";

/** `{ series, number }` of a readable code (lenient V, strict S); null for anything else. */
export function parseVideoCode(value: string): { series: VideoSeries; number: number } | null {
  if (!isReadableVideoCode(value)) return null;
  return { series: value[0] as VideoSeries, number: Number(value.slice(1)) };
}

/** The series of a readable code, or null. */
export function videoCodeSeries(value: string): VideoSeries | null {
  return parseVideoCode(value)?.series ?? null;
}

/** Ascending: the V block first, then S; inside a block by number (numeric: `S2 < S10`). An unreadable code sorts last. */
export function compareVideoCodes(a: string, b: string): number {
  const pa = parseVideoCode(a);
  const pb = parseVideoCode(b);
  if (!pa || !pb) return (pa ? 0 : 1) - (pb ? 0 : 1) || (a < b ? -1 : a > b ? 1 : 0);
  const series = VIDEO_SERIES.indexOf(pa.series) - VIDEO_SERIES.indexOf(pb.series);
  return series || pa.number - pb.number || (a < b ? -1 : a > b ? 1 : 0);
}

/** Highest first: the V block first, then S; inside a block by number descending (`V10, V2, S10, S2`). Unreadable codes last. */
export function compareVideoCodesDesc(a: string, b: string): number {
  const pa = parseVideoCode(a);
  const pb = parseVideoCode(b);
  if (!pa || !pb) return (pa ? 0 : 1) - (pb ? 0 : 1) || (a < b ? -1 : a > b ? 1 : 0);
  const series = VIDEO_SERIES.indexOf(pa.series) - VIDEO_SERIES.indexOf(pb.series);
  return series || pb.number - pa.number || (a < b ? -1 : a > b ? 1 : 0);
}

/** Whether any of `codes` is an S code (the per-device reports are written as version 2 only then, plan §5). */
export function hasSCode(codes: Iterable<string | null | undefined>): boolean {
  for (const code of codes) if (code && code.startsWith("S") && isStrictSCode(code)) return true;
  return false;
}

/**
 * The version a per-device report holding `codes` is written with (plan §5, the BL-229 precedent): 1 exactly as before while it
 * holds no S code, 2 as soon as it holds one -- so an older build reads every V-only report and says "update the app" for the rest.
 */
export function reportVersionFor(codes: Iterable<string | null | undefined>): 1 | 2 {
  return hasSCode(codes) ? 2 : 1;
}
