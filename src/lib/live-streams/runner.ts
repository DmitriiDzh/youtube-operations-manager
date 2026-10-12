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
/** §3.10: every minute for the first 10 minutes after an encoder (re)start, then every 5 minutes. */
export const BROADCAST_CHECK_FAST_MS = 60_000;
export const BROADCAST_FAST_WINDOW_MS = 10 * 60_000;
/** Waits between failed encoder starts of one stream (each start reads YouTube: the key, the rotation). */
export const START_RETRY_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000] as const;
/** An encoder gone within this long after its start counts as a failed start (backoff), not a fresh reason to start again. */
export const EARLY_EXIT_MS = 2 * 60_000;

export type RunnerDependencies = {
  settings(): Promise<LiveStreamsSettings & { host: { ok: true } | { ok: false; reason: string } }>;
  listStreams(): Promise<Array<{ channelId: string; intent: "on" | "off" }>>;
  supervisor: Pick<StreamSupervisor, "runningHelper" | "liveHelper" | "startEncoder" | "stopEncoder" | "tick" | "checkBroadcast">;
  event(channelId: string, kind: string, detail: Record<string, unknown>): Promise<void>;
  /** §3.11: this computer's report for the other computers; `false` publishes an empty one (the module is off). */
  publish?(enabled: boolean): Promise<void>;
  now(): number;
};

export function createLiveStreamsRunner(deps: RunnerDependencies) {
  const lastBroadcastCheck = new Map<string, number>();
  const startFailures = new Map<string, { count: number; retryAt: number; message: string }>();
  let publishedOff = false;
  let stoppedForOff = false;
  const lastStarted = new Map<string, number>();

  function noteFailure(channelId: string, message: string, now: number) {
    const failure = startFailures.get(channelId);
    const count = (failure?.count ?? 0) + 1;
    const delay = START_RETRY_DELAYS_MS[Math.min(count - 1, START_RETRY_DELAYS_MS.length - 1)];
    startFailures.set(channelId, { count, retryAt: now + delay, message });
    return { changed: failure?.message !== message, delay };
  }

  async function tendStream(channelId: string): Promise<void> {
    const now = deps.now();
    const running = await deps.supervisor.runningHelper(channelId);
    if (!running) {
      // An encoder that died right after this loop started it is a failed start: back off instead of restarting every 15 s
      // (each start reads YouTube).
      const started = lastStarted.get(channelId);
      if (started !== undefined && now - started < EARLY_EXIT_MS) {
        lastStarted.delete(channelId);
        const { changed, delay } = noteFailure(channelId, "the encoder stopped right after starting", now);
        if (changed) await deps.event(channelId, "encoder_start_failed", { message: "the encoder stopped right after starting", retryInSeconds: delay / 1000 });
        return;
      }
      const failure = startFailures.get(channelId);
      if (failure && now < failure.retryAt) return;
      try {
        await deps.supervisor.startEncoder(channelId, { freshPass: false });
        // From when the encoder really started (filling the buffer may have taken minutes).
        lastStarted.set(channelId, deps.now());
        lastBroadcastCheck.delete(channelId); // read the broadcast at the next tick (§3.8: after every (re)start)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const { changed, delay } = noteFailure(channelId, message, now);
        if (changed) await deps.event(channelId, "encoder_start_failed", { message, retryInSeconds: delay / 1000 });
      }
      return;
    }
    // Running for a while: a start that worked clears the backoff.
    const started = lastStarted.get(channelId);
    if (started === undefined || now - started >= EARLY_EXIT_MS) startFailures.delete(channelId);
    await deps.supervisor.tick(channelId);
    // §3.8/§3.10: the broadcast is read right after every encoder (re)start -- the owner's Start included -- then every
    // minute for 10 minutes, then every 5 minutes.
    const startedAt = running.record.startedAt;
    const last = lastBroadcastCheck.get(channelId);
    const interval = now - startedAt < BROADCAST_FAST_WINDOW_MS ? BROADCAST_CHECK_FAST_MS : BROADCAST_CHECK_INTERVAL_MS;
    if (last === undefined || last < startedAt || now - last >= interval) {
      lastBroadcastCheck.set(channelId, now);
      await deps.supervisor.checkBroadcast(channelId);
    }
  }

  return {
    async tick(): Promise<void> {
      const settings = await deps.settings();
      if (!settings.enabled || !settings.host.ok) {
        // Once: the encoders still running stop (the intent stays, so they come back when the module is switched on again --
        // no YouTube write either way), and the other computers stop showing streams this one no longer runs.
        if (!stoppedForOff) {
          stoppedForOff = true;
          for (const stream of await deps.listStreams().catch(() => [])) {
            await deps.supervisor.stopEncoder(stream.channelId, "module_off").catch(() => false);
          }
        }
        if (!publishedOff && deps.publish) {
          publishedOff = true;
          await deps.publish(false).catch(() => undefined);
        }
        return;
      }
      publishedOff = false;
      stoppedForOff = false;
      for (const stream of await deps.listStreams()) {
        if (stream.intent !== "on") {
          // A stream the owner stopped never keeps an encoder (e.g. one a Stop could not reach in time).
          if (await deps.supervisor.liveHelper(stream.channelId).catch(() => null)) await deps.supervisor.stopEncoder(stream.channelId, "intent_off").catch(() => false);
          continue;
        }
        try {
          await tendStream(stream.channelId);
        } catch (error) {
          // One stream's trouble never stops the others (a YouTube read failing, a file busy...): the next tick retries.
          console.warn(`[live-streams] ${stream.channelId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await deps.publish?.(true).catch((error: unknown) => console.warn(`[live-streams] report: ${error instanceof Error ? error.message : String(error)}`));
    },
  };
}

export type LiveStreamsRunner = ReturnType<typeof createLiveStreamsRunner>;
