// BL-149 follow-up (owner, Telegram 2026-10-07, msg 2004): what the app is doing right after it opens and while the active
// channel switches, for the blurred loading overlay. Pure: the (app) layout feeds it the outcome of each request it already
// makes; nothing here starts a request.

export type StartupStepKey = "channel" | "analytics" | "research" | "reach";
export type StepState = "waiting" | "running" | "done" | "skipped" | "failed";
export type StepStatus = { state: StepState; detail: string | null };
export type StartupProgress = Record<StartupStepKey, StepStatus>;

export const STARTUP_STEPS: ReadonlyArray<{ key: StartupStepKey; label: string }> = [
  { key: "channel", label: "Active channel" },
  { key: "analytics", label: "Analytics (all channels)" },
  { key: "research", label: "Research (after syncing with the other computer)" },
  { key: "reach", label: "Reach reports" },
];

export const INITIAL_STARTUP: StartupProgress = {
  channel: { state: "running", detail: null },
  analytics: { state: "waiting", detail: null },
  research: { state: "waiting", detail: null },
  reach: { state: "waiting", detail: null },
};

/** The overlay stays while a step is still waiting or running. */
export function startupInProgress(progress: StartupProgress): boolean {
  return Object.values(progress).some((s) => s.state === "waiting" || s.state === "running");
}

/**
 * No active channel this load: it could not be read (a stale sign-in, a network error) or there is none yet. The collections that
 * wait for it will not run, so they are marked as not run and the window can close (review M6: it must never wait forever).
 */
export function channelUnavailable(progress: StartupProgress, detail = "reconnect needed", state: "failed" | "skipped" = "failed"): StartupProgress {
  const skip = (s: StepStatus): StepStatus => (s.state === "waiting" ? { state: "skipped", detail: "needs the active channel" } : s);
  return { channel: { state, detail }, analytics: skip(progress.analytics), research: skip(progress.research), reach: skip(progress.reach) };
}

/** `POST /api/analytics/auto-collect-all` → its step (the active channel is collected before the response; the rest continue in the background). */
export function analyticsOutcome(ok: boolean, body: unknown): StepStatus {
  if (!ok) return { state: "failed", detail: null };
  const b = (body ?? {}) as { channels?: Array<{ collection?: string; error?: string }>; inProgress?: boolean; importedFromPeers?: number; importPending?: boolean };
  if (b.inProgress) return { state: "done", detail: "already running" };
  if (b.importPending) return { state: "skipped", detail: "the other computer's data is still arriving; collected on the next start" };
  const active = b.channels ?? [];
  // Review M5: a failed or skipped active channel is not "up to date".
  const failed = active.find((c) => c.collection === "failed");
  if (failed) return { state: "failed", detail: failed.error ?? null };
  const skipped = active.find((c) => typeof c.collection === "string" && c.collection.startsWith("skipped"));
  if (skipped) return { state: "skipped", detail: skipped.collection === "skipped_no_user" ? "no connected Google account for this channel" : null };
  const collected = active.some((c) => c.collection === "collected");
  if (collected) return { state: "done", detail: "updated; other channels continue in the background" };
  // BL-151 (AC-AD-06): the other computer's rows arrived first and made today's collection unnecessary.
  return { state: "done", detail: (b.importedFromPeers ?? 0) > 0 ? "up to date — collected on the other computer" : "up to date" };
}

/** `POST /api/market-intelligence/collect-if-stale` → its step (it first syncs with the other computer, then collects if due). */
export function researchOutcome(ok: boolean, body: unknown): StepStatus {
  if (!ok) return { state: "failed", detail: null };
  const b = (body ?? {}) as { skipped?: boolean; reason?: string };
  if (b.skipped) return { state: "skipped", detail: b.reason ?? null };
  return { state: "done", detail: null };
}

/** `POST /api/reach/sync-all` → its step. */
export function reachOutcome(ok: boolean, body?: unknown): StepStatus {
  if (!ok) return { state: "failed", detail: null };
  if ((body as { importPending?: boolean } | null)?.importPending) return { state: "skipped", detail: "the other computer's data is still arriving; checked on the next start" };
  return { state: "done", detail: null };
}
