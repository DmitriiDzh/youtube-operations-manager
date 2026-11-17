// BL-271 (docs/roadmap/plans/WAIT_TOOLS_PLAN.md, ADR 0075): waiting for a long operation without spending agent tokens. Types and
// fixed values only -- no database, no process, no files (the CLI imports this file too).

/** Every operation an agent can wait on (plan §2). The weekly build (Q4) and recode / rename (Q5) are deliberately not here. */
export const WAIT_TARGETS = [
  "upload",
  "media_session",
  "media_job",
  "gemini_job",
  "speech_job",
  "sound_job",
  "translation_request",
  "storyboard_review",
  "storyboard_render",
  "restart",
] as const;
export type WaitTarget = (typeof WAIT_TARGETS)[number];

/** `until` per target (plan §2): media_session ready (default) | ended; translation_request finished (default) | claimed. */
export const WAIT_UNTIL: Readonly<Partial<Record<WaitTarget, readonly string[]>>> = Object.freeze({
  media_session: ["ready", "ended"],
  translation_request: ["finished", "claimed"],
});

export const WAIT_OUTCOMES = [
  "succeeded",
  "failed",
  "partly_failed",
  "cancelled",
  "rejected",
  "changes_requested",
  "expired",
  "still_running",
  "blocked",
  "not_in_review",
  "restarting",
  "server_stopping",
] as const;
export type WaitOutcome = (typeof WAIT_OUTCOMES)[number];

/**
 * One MCP call blocks at most this long (plan §3.4, ADR 0075). Kept under the clients' limits measured in stage 0; a longer wait goes
 * through the CLI, which repeats calls of WAIT_MAX_SECONDS.
 */
export const WAIT_DEFAULT_SECONDS = 50;
export const WAIT_MAX_SECONDS = 240;
export const WAIT_MIN_SECONDS = 1;

/** How often a target is read (plan §2): one SQLite row every 5 s (an upload every 10 s), an Automerge document every 15 s. */
export const WAIT_POLL_MS: Readonly<Record<WaitTarget, number>> = Object.freeze({
  upload: 10_000,
  media_session: 5_000,
  media_job: 5_000,
  gemini_job: 5_000,
  speech_job: 5_000,
  sound_job: 5_000,
  translation_request: 15_000,
  storyboard_review: 15_000,
  storyboard_render: 15_000,
  restart: 5_000,
});

/** Failed reads in a row before a wait answers `target_unavailable` (one failure is retried at the next poll). */
export const WAIT_MAX_FAILED_READS = 3;

/** The input of `factory_wait` / `agent_wait` / `producer_wait` (the endpoints' schemas give the shape; the core checks it again). */
export type WaitInput = {
  target: WaitTarget;
  id: string;
  channelId?: string;
  storyboardId?: string;
  until?: string;
  timeoutSeconds?: number;
};

/** Who asks: a channel worker's calls are confined to its channel (`channelId`), the Operator's and the Producer's are not (null). */
export type WaitScope = { channelId: string | null };

/** One read of a target. `id` is the resolved id (restart `current` -> the request's id; an upload's video code -> its upload id). */
export type WaitObservation = {
  id: string;
  status: string;
  final: boolean;
  outcome: WaitOutcome;
  snapshot: Record<string, unknown>;
};

/** Reads one target. Throws `WaitNotFoundError` for an id that is missing -- or another channel's, answered the same way. */
export type WaitPort = (input: WaitInput, scope: WaitScope) => Promise<WaitObservation>;

/** The answer of a wait (plan §3.2): always a success result; `final: false` means "not finished yet" (act only on `final: true`). */
export type WaitResult = {
  target: WaitTarget;
  id: string;
  final: boolean;
  outcome: WaitOutcome;
  status: string;
  snapshot: Record<string, unknown>;
  waitedSeconds: number;
  nextCallHint?: string;
};

/** The CLI's exit code for an outcome (plan §3.3): 0 succeeded; 1 failed / partly failed / cancelled / rejected / changes requested / expired; 2 everything else. */
export function exitCodeFor(outcome: WaitOutcome | null): 0 | 1 | 2 {
  if (outcome === "succeeded") return 0;
  if (outcome === "failed" || outcome === "partly_failed" || outcome === "cancelled" || outcome === "rejected" || outcome === "changes_requested" || outcome === "expired") return 1;
  return 2;
}

/** `timeoutSeconds` clamped to 1..240; absent (or not a finite number) = 50 (plan §3.2, AC-WT-05). */
export function clampTimeoutSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return WAIT_DEFAULT_SECONDS;
  return Math.min(WAIT_MAX_SECONDS, Math.max(WAIT_MIN_SECONDS, value));
}

/** A port's "no such id here" (or "not yours": the same answer). The core turns it into the error `not_found`. */
export class WaitNotFoundError extends Error {
  constructor() {
    super("not found");
    this.name = "WaitNotFoundError";
  }
}

/** The tool description's and a not-final result's pointer to the CLI (plan §3.4). */
export const WAIT_CLI_HINT =
  "For a wait longer than about 4 minutes, run the CLI as a background shell command instead of calling this tool again: npm --prefix <app folder> run --silent wait -- <target> <id> [--channel <channelId>] [--storyboard <storyboardId>] [--until <until>] [--timeout <seconds>] (the token in the environment variable YTOM_TOKEN, or --token-env <VAR>); it prints one JSON line when the operation is final.";
