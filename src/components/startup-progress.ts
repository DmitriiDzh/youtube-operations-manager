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

/** The channel could not be read (typically a stale sign-in): the collections that wait for it will not run this load. */
export function channelUnavailable(progress: StartupProgress): StartupProgress {
  const skip = (s: StepStatus): StepStatus => (s.state === "waiting" ? { state: "skipped", detail: "needs the active channel" } : s);
  return { channel: { state: "failed", detail: "reconnect needed" }, analytics: skip(progress.analytics), research: skip(progress.research), reach: skip(progress.reach) };
}

/** `POST /api/analytics/auto-collect-all` → its step (the active channel is collected before the response; the rest continue in the background). */
export function analyticsOutcome(ok: boolean, body: unknown): StepStatus {
  if (!ok) return { state: "failed", detail: null };
  const b = (body ?? {}) as { channels?: Array<{ collection?: string }>; inProgress?: boolean };
  if (b.inProgress) return { state: "done", detail: "already running" };
  const collected = (b.channels ?? []).some((c) => c.collection === "collected");
  return { state: "done", detail: collected ? "updated; other channels continue in the background" : "up to date" };
}

/** `POST /api/market-intelligence/collect-if-stale` → its step (it first syncs with the other computer, then collects if due). */
export function researchOutcome(ok: boolean, body: unknown): StepStatus {
  if (!ok) return { state: "failed", detail: null };
  const b = (body ?? {}) as { skipped?: boolean; reason?: string };
  if (b.skipped) return { state: "skipped", detail: b.reason ?? null };
  return { state: "done", detail: null };
}

/** `POST /api/reach/sync-all` → its step. */
export function reachOutcome(ok: boolean): StepStatus {
  return ok ? { state: "done", detail: null } : { state: "failed", detail: null };
}
