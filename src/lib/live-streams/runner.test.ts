import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LIVE_STREAMS_SETTINGS } from "./contracts";
import { BROADCAST_CHECK_INTERVAL_MS, createLiveStreamsRunner } from "./runner";

// BL-176 (LIVE_STREAMS_PLAN.md §3.1 "the owner's on is a saved intent", §3.6 "after a Mac restart", §3.8 "after every
// encoder (re)start, the app reads the broadcast", ADR 0036 §2 "switched off: no timers, no processes").

function harness(opts: { enabled?: boolean; hostOk?: boolean; streams?: Array<{ channelId: string; intent: "on" | "off" }>; startFails?: string; strays?: string[]; endedByYoutube?: boolean } = {}) {
  const calls: string[] = [];
  let running = new Set<string>();
  const strays = new Set<string>(opts.strays ?? []);
  const startedAt = new Map<string, number>();
  let clock = 0;
  const events: string[] = [];
  const runner = createLiveStreamsRunner({
    settings: async () => ({ ...DEFAULT_LIVE_STREAMS_SETTINGS, enabled: opts.enabled ?? true, host: opts.hostOk === false ? { ok: false, reason: "not the service" } : { ok: true } }),
    listStreams: async () => opts.streams ?? [{ channelId: "UC1", intent: "on" }, { channelId: "UC2", intent: "off" }],
    supervisor: {
      runningHelper: async (c) => {
        calls.push(`running:${c}`);
        return running.has(c) ? ({ record: { startedAt: startedAt.get(c) ?? 0 } } as never) : null;
      },
      liveHelper: async (c) => (strays.has(c) ? ({ pid: 1 } as never) : null),
      stopEncoder: async (c, reason) => {
        calls.push(`stop:${c}:${reason}`);
        strays.delete(c);
        running.delete(c);
        return true;
      },
      startEncoder: async (c) => {
        calls.push(`start:${c}`);
        if (opts.startFails) throw new Error(opts.startFails);
        running = new Set([...running, c]);
        startedAt.set(c, clock);
        return { pid: 1 };
      },
      tick: async (c) => {
        calls.push(`tick:${c}`);
        return { running: true, status: null };
      },
      checkBroadcast: async (c) => {
        calls.push(`check:${c}`);
        return opts.endedByYoutube ? { lifeCycleStatus: "complete", endedByYoutube: true } : { lifeCycleStatus: "live", endedByYoutube: false };
      },
    },
    segments: { tick: async (c) => void calls.push(`segments:${c}`) },
    event: async (_c, kind, detail) => void events.push(`${kind}:${String(detail.message)}`),
    now: () => clock,
  });
  return {
    runner,
    calls,
    events,
    advance: (ms: number) => void (clock += ms),
    kill: (c: string) => void running.delete(c),
    ownerStarted: (c: string) => {
      running = new Set([...running, c]);
      startedAt.set(c, clock);
    },
  };
}

test("switched off, or on a computer that cannot host streams: running encoders are stopped once (no write), then nothing", async () => {
  for (const options of [{ enabled: false }, { hostOk: false }]) {
    const h = harness(options);
    await h.runner.tick();
    assert.deepEqual(h.calls, ["stop:UC1:module_off", "stop:UC2:module_off"]);
    h.calls.length = 0;
    await h.runner.tick();
    assert.deepEqual(h.calls, [], "only once");
  }
});

test("a stream whose intent is off never keeps an encoder: a stray one is stopped", async () => {
  const h = harness({ strays: ["UC2"] });
  await h.runner.tick();
  assert.ok(h.calls.includes("stop:UC2:intent_off"));
});

test("an encoder that dies right after its start counts as a failed start (backoff), not a restart every 15 s", async () => {
  const h = harness({ streams: [{ channelId: "UC1", intent: "on" }] });
  await h.runner.tick(); // started
  h.kill("UC1"); // gone at once
  h.advance(15_000);
  await h.runner.tick();
  h.advance(15_000);
  await h.runner.tick();
  assert.equal(h.calls.filter((c) => c === "start:UC1").length, 1, "no restart within the backoff");
  assert.deepEqual(h.events, ["encoder_start_failed:the encoder stopped right after starting"]);
  h.advance(60_000);
  await h.runner.tick();
  assert.equal(h.calls.filter((c) => c === "start:UC1").length, 2, "retried after 1 minute");
});

test("a stream that is on gets its encoder started when none runs (boot / after a crash of the helper); off streams are left alone", async () => {
  const h = harness();
  await h.runner.tick();
  assert.deepEqual(h.calls, ["running:UC1", "start:UC1"]);
});

test("after a (re)start the broadcast is read at once, every minute for 10 minutes, then every 5 minutes", async () => {
  const h = harness();
  await h.runner.tick(); // the encoder starts at 0
  h.calls.length = 0;
  await h.runner.tick();
  // BL-205: the segment switcher is ticked after the check (the harness now plugs one in).
  assert.deepEqual(h.calls, ["running:UC1", "tick:UC1", "check:UC1", "segments:UC1"], "read right after the start");
  h.calls.length = 0;
  h.advance(30_000);
  await h.runner.tick();
  assert.ok(!h.calls.includes("check:UC1"), "not again within the minute");
  h.advance(30_000);
  await h.runner.tick();
  assert.ok(h.calls.includes("check:UC1"), "every minute in the first 10");
  h.advance(10 * 60_000);
  await h.runner.tick();
  h.calls.length = 0;
  h.advance(60_000);
  await h.runner.tick();
  assert.ok(!h.calls.includes("check:UC1"), "after 10 minutes: not every minute");
  h.advance(BROADCAST_CHECK_INTERVAL_MS);
  await h.runner.tick();
  assert.ok(h.calls.includes("check:UC1"), "every 5 minutes");
});

test("an encoder the owner's Start launched is read at the next tick too", async () => {
  const h = harness({ streams: [{ channelId: "UC1", intent: "on" }] });
  h.ownerStarted("UC1");
  h.advance(BROADCAST_CHECK_INTERVAL_MS * 3);
  await h.runner.tick();
  h.calls.length = 0;
  h.advance(60_000);
  h.ownerStarted("UC1"); // a new Start (or restart) after the last read
  await h.runner.tick();
  assert.ok(h.calls.includes("check:UC1"));
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
    supervisor: {
      runningHelper: async () => null,
      liveHelper: async () => null,
      startEncoder: async () => ({ pid: 1 }),
      stopEncoder: async () => false,
      tick: async () => ({ running: false, status: null }),
      checkBroadcast: async () => ({ lifeCycleStatus: null, endedByYoutube: false }),
    },
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

test("an encoder that keeps dying right after its start backs off every time: 1, 2, 5, then 10 minutes (verification review)", async () => {
  const h = harness({ streams: [{ channelId: "UC1", intent: "on" }] });
  const starts = () => h.calls.filter((c) => c === "start:UC1").length;
  await h.runner.tick(); // start 1 at 0
  for (const wait of [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000]) {
    h.kill("UC1");
    h.advance(15_000);
    await h.runner.tick(); // the early death is noted
    const before = starts();
    h.advance(wait - 30_000);
    await h.runner.tick();
    assert.equal(starts(), before, `no start before ${wait / 60_000} min`);
    h.advance(30_000);
    await h.runner.tick();
    assert.equal(starts(), before + 1, `a start after ${wait / 60_000} min`);
  }
});

// BL-205 (LIVE_SEGMENTS_PLAN.md §2.2): the segment switcher runs only for a stream whose encoder runs, after it is tended, and never
// once YouTube has ended the stream's broadcast (AC-SEG-07: the switch hands the row over before ending the old one, so an ended
// broadcast seen here is the stream's own end).
test("segments: ticked for a running stream after its broadcast check; not for a stopped one; not once YouTube ended the broadcast", async () => {
  const h = harness();
  h.ownerStarted("UC1");
  await h.runner.tick();
  assert.deepEqual(h.calls.filter((c) => c.startsWith("check:") || c.startsWith("segments:")), ["check:UC1", "segments:UC1"]);

  const ended = harness({ endedByYoutube: true });
  ended.ownerStarted("UC1");
  await ended.runner.tick();
  assert.ok(!ended.calls.includes("segments:UC1"));

  const off = harness({ streams: [{ channelId: "UC1", intent: "off" }] });
  await off.runner.tick();
  assert.ok(!off.calls.some((c) => c.startsWith("segments:")));
});
