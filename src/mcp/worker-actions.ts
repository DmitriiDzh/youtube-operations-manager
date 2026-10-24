/**
 * BL-215 (ADR 0048, `docs/roadmap/plans/WORKER_CAPABILITIES_PLAN.md` AC-WK-06): which channel-agent ("worker") tool calls would
 * really write to YouTube, and what each one is about -- the input of the worker log the channel session's wrapper in
 * `./server.ts` writes. Pure: no database, no YouTube.
 *
 * `apply` and `agent_set_privacy` (BL-216) write only with an explicit `dryRun: false` (both default to a preview); the four
 * playlist tools always write.
 * `playlist_delete` is not here: it is never registered for a worker (operator-only, ADR 0048 §3).
 */

type ToolArgs = Record<string, unknown> | undefined;

export type WorkerWriteDescription = { target: string | null; detail: Record<string, unknown> };

const MAX_DETAIL_LENGTH = 500;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function videoIds(args: ToolArgs): string[] {
  const ids = args?.videoIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

function detail(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** The log's `detail` column: the fields as JSON, cut to a bounded length (a long list of video ids ends with "…"). */
export function serializeWorkerDetail(fields: Record<string, unknown>): string | null {
  if (Object.keys(fields).length === 0) return null;
  const json = JSON.stringify(fields);
  return json.length > MAX_DETAIL_LENGTH ? `${json.slice(0, MAX_DETAIL_LENGTH - 1)}…` : json;
}

const DESCRIBE: Readonly<Record<string, (args: ToolArgs) => WorkerWriteDescription | null>> = Object.freeze({
  apply: (args) =>
    args?.dryRun === false ? { target: text(args.videoId), detail: detail({ fields: ["title", "description"] }) } : null,
  playlist_create: (args) => ({
    target: null,
    detail: detail({ title: text(args?.title), privacyStatus: text(args?.privacyStatus) ?? "private" }),
  }),
  playlist_update: (args) => ({
    target: text(args?.playlistId),
    detail: detail({
      fields: ["title", "description", "privacyStatus"].filter((field) => args?.[field] !== undefined),
      privacyStatus: text(args?.privacyStatus) ?? undefined,
    }),
  }),
  agent_set_privacy: (args) =>
    args?.dryRun === false ? { target: text(args.id), detail: detail({ target: text(args.target), privacyStatus: text(args.privacyStatus) }) } : null,
  playlist_add_videos: (args) => ({ target: text(args?.playlistId), detail: detail({ videoIds: videoIds(args) }) }),
  playlist_remove_videos: (args) => ({ target: text(args?.playlistId), detail: detail({ videoIds: videoIds(args) }) }),
});

/** The tools that can write to YouTube for a worker (for the capability inventory's test, ADR 0048 §1). */
export const WORKER_YOUTUBE_WRITE_TOOLS: readonly string[] = Object.freeze(Object.keys(DESCRIBE));

/** What a worker call of `tool` would write, or `null` when it would not write to YouTube (a read, or `apply` as a preview). */
export function describeWorkerWrite(tool: string, args: unknown): WorkerWriteDescription | null {
  const describe = DESCRIBE[tool];
  if (!describe) return null;
  return describe(typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined);
}

/**
 * What only YouTube's answer tells: a created playlist's id (it has none before), and how many videos of an add/remove failed (those
 * two tools answer `ok` with per-video failures).
 */
export function fromToolResult(
  tool: string,
  structured: unknown
): { target: string | null; failedVideos: number | null; previousPrivacyStatus: string | null; changed: boolean | null } {
  const result = typeof structured === "object" && structured !== null ? (structured as Record<string, unknown>) : {};
  const playlist = result.playlist as { id?: unknown } | undefined;
  const failures = result.failures;
  const privacy = tool === "agent_set_privacy";
  return {
    target: tool === "playlist_create" ? text(playlist?.id) : null,
    failedVideos: (tool === "playlist_add_videos" || tool === "playlist_remove_videos") && Array.isArray(failures) ? failures.length : null,
    // BL-216: the status before the change, as the tool read it from YouTube (AC-WP-07), and whether anything was written.
    previousPrivacyStatus: privacy ? text(result.previousPrivacyStatus) : null,
    changed: privacy && typeof result.changed === "boolean" ? result.changed : null,
  };
}
