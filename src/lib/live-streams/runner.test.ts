import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LIVE_STREAMS_SETTINGS } from "./contracts";
import { BROADCAST_CHECK_INTERVAL_MS, createLiveStreamsRunner } from "./runner";

// BL-176 (LIVE_STREAMS_PLAN.md §3.1 "the owner's on is a saved intent", §3.6 "after a Mac restart", §3.8 "after every
// encoder (re)start, the app reads the broadcast", ADR 0036 §2 "switched off: no timers, no processes").

function harness(opts: { enabled?: boolean; hostOk?: boolean; streams?: Array<{ channelId: string; intent: "on" | "off" }>; startFails?: string } = {}) {
  const calls: string[] = [];
  let running = new Set<string>();
  let clock = 0;
  const events: string[] = [];
  const runner = createLiveStreamsRunner({
    settings: async () => ({ ...DEFAULT_LIVE_STREAMS_SETTINGS, enabled: opts.enabled ?? true, host: opts.hostOk === false ? { ok: false, reason: "not the service" } : { ok: true } }),
    listStreams: async () => opts.streams ?? [{ channelId: "UC1", intent: "on" }, { channelId: "UC2", intent: "off" }],
    supervisor: {
      runningHelper: async (c) => {
        calls.push(`running:${c}`);
        return running.has(c) ? ({} as never) : null;
      },
      startEncoder: async (c) => {
        calls.push(`start:${c}`);
        if (opts.startFails) throw new Error(opts.startFails);
        running = new Set([...running, c]);
        return { pid: 1 };
      },
      tick: async (c) => {
        calls.push(`tick:${c}`);
        return { running: true, status: null };
      },
      checkBroadcast: async (c) => {
        calls.push(`check:${c}`);
        return { lifeCycleStatus: "live", endedByYoutube: false };
      },
    },
    event: async (_c, kind, detail) => void events.push(`${kind}:${String(detail.message)}`),
    now: () => clock,
  });
  return { runner, calls, events, advance: (ms: number) => void (clock += ms), kill: (c: string) => void running.delete(c) };
}

test("switched off, or on a computer that cannot host streams, a tick touches nothing", async () => {
  for (const options of [{ enabled: false }, { hostOk: false }]) {
    const h = harness(options);
    await h.runner.tick();
    assert.deepEqual(h.calls, []);
  }
});

test("a stream that is on gets its encoder started when none runs (boot / after a crash of the helper); off streams are left alone", async () => {
  const h = harness();
  await h.runner.tick();
  assert.deepEqual(h.calls, ["running:UC1", "start:UC1"]);
});

test("after a (re)start the broadcast is read at the next tick, then every 5 minutes", async () => {
  const h = harness();
  await h.runner.tick(); // start
  h.advance(BROADCAST_CHECK_INTERVAL_MS + 1); // clock past the first window
  await h.runner.tick();
  assert.deepEqual(h.calls.slice(2), ["running:UC1", "tick:UC1", "check:UC1"]);
  h.calls.length = 0;
  h.advance(60_000);
  await h.runner.tick();
  assert.deepEqual(h.calls, ["running:UC1", "tick:UC1"], "no read before 5 minutes");
  h.advance(BROADCAST_CHECK_INTERVAL_MS);
  await h.runner.tick();
  assert.deepEqual(h.calls.slice(-1), ["check:UC1"]);
});

test("a failing start is retried after 1, 2, 5 then 10 minutes, and recorded once per distinct message", async () => {
  const h = harness({ startFails: "YouTube did not return the key" });
  await h.runner.tick();
  h.advance(30_000);
  await h.runner.tick();
  assert.equal(h.calls.filter((c) => c === "start:UC1").length, 1, "no retry within the first minute");
  h.advance(30_000);
  await h.runner.tick();
  assert.equal(h.calls.filter((c) => c === "start:UC1").length, 2);
  h.advance(2 * 60_000);
  await h.runner.tick();
  assert.equal(h.calls.filter((c) => c === "start:UC1").length, 3);
  assert.deepEqual(h.events, ["encoder_start_failed:YouTube did not return the key"]);
});

test("§3.11: a working tick publishes this computer's report; switched off, an empty report is published once", async () => {
  const published: boolean[] = [];
  let enabled = true;
  const runner = createLiveStreamsRunner({
    settings: async () => ({ ...DEFAULT_LIVE_STREAMS_SETTINGS, enabled, host: { ok: true } }),
    listStreams: async () => [],
    supervisor: { runningHelper: async () => null, startEncoder: async () => ({ pid: 1 }), tick: async () => ({ running: false, status: null }), checkBroadcast: async () => ({ lifeCycleStatus: null, endedByYoutube: false }) },
    event: async () => undefined,
    publish: async (on) => void published.push(on),
    now: () => 0,
  });
  await runner.tick();
  enabled = false;
  await runner.tick();
  await runner.tick();
  assert.deepEqual(published, [true, false]);
});
