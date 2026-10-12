import type { LiveStreamsSettings } from "./contracts";
import type { StreamSupervisor } from "./supervisor";

// ---------------------------------------------------------------------------
// BL-176 (LIVE_STREAMS_PLAN.md §3.1/§3.6/§3.8, ADR 0036 §4) -- what the server does for live streams on its own, every
// few seconds. The owner's "on" is a saved intent: a stream that is on gets its encoder running again after a crash, a
// server restart or a Mac restart (adopted when still running, else started -- the key is read from YouTube, a read).
// Every running stream is tended (position, buffer, next pass), and its broadcast is read right after each (re)start and
// every 5 minutes (§3.8). Switched off, or on a computer that cannot host streams, a tick does nothing at all.
// Nothing here writes to YouTube.
// ---------------------------------------------------------------------------

export const BROADCAST_CHECK_INTERVAL_MS = 5 * 60_000;
/** Waits between failed encoder starts of one stream (each start reads YouTube: the key, the rotation). */
export const START_RETRY_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000] as const;

export type RunnerDependencies = {
  settings(): Promise<LiveStreamsSettings & { host: { ok: true } | { ok: false; reason: string } }>;
  listStreams(): Promise<Array<{ channelId: string; intent: "on" | "off" }>>;
  supervisor: Pick<StreamSupervisor, "runningHelper" | "startEncoder" | "tick" | "checkBroadcast">;
  event(channelId: string, kind: string, detail: Record<string, unknown>): Promise<void>;
  now(): number;
};

export function createLiveStreamsRunner(deps: RunnerDependencies) {
  const lastBroadcastCheck = new Map<string, number>();
  const startFailures = new Map<string, { count: number; retryAt: number; message: string }>();

  async function tendStream(channelId: string): Promise<void> {
    const now = deps.now();
    if (!(await deps.supervisor.runningHelper(channelId))) {
      const failure = startFailures.get(channelId);
      if (failure && now < failure.retryAt) return;
      try {
        await deps.supervisor.startEncoder(channelId, { freshPass: false });
        startFailures.delete(channelId);
        lastBroadcastCheck.set(channelId, 0); // read the broadcast at the next tick (§3.8: after every (re)start)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const count = (failure?.count ?? 0) + 1;
        const delay = START_RETRY_DELAYS_MS[Math.min(count - 1, START_RETRY_DELAYS_MS.length - 1)];
        startFailures.set(channelId, { count, retryAt: now + delay, message });
        if (failure?.message !== message) await deps.event(channelId, "encoder_start_failed", { message, retryInSeconds: delay / 1000 });
      }
      return;
    }
    await deps.supervisor.tick(channelId);
    if (now - (lastBroadcastCheck.get(channelId) ?? 0) >= BROADCAST_CHECK_INTERVAL_MS) {
      lastBroadcastCheck.set(channelId, now);
      await deps.supervisor.checkBroadcast(channelId);
    }
  }

  return {
    async tick(): Promise<void> {
      const settings = await deps.settings();
      if (!settings.enabled || !settings.host.ok) return;
      for (const stream of await deps.listStreams()) {
        if (stream.intent !== "on") continue;
        try {
          await tendStream(stream.channelId);
        } catch (error) {
          // One stream's trouble never stops the others (a YouTube read failing, a file busy...): the next tick retries.
          console.warn(`[live-streams] ${stream.channelId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}

export type LiveStreamsRunner = ReturnType<typeof createLiveStreamsRunner>;
