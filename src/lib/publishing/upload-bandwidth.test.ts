import assert from "node:assert/strict";
import test from "node:test";
import {
  createUploadBandwidthGovernor,
  HOLD_CEILING_MS,
  limitedChunkBytes,
  type EncoderSample,
  type LiveLoad,
  type UploadBandwidthEvent,
} from "./upload-bandwidth";

// BL-233 acceptance (FO-REQ-0047, the brief's acceptance list; fixed before the code):
// - during an upload with a live stream on, the upload is held to the limit; with no stream it is not limited;
// - a stream below 0.97x for N minutes holds the upload; 0.99x for a minute lets it go again;
// - a hold never exceeds 30 minutes (then the upload goes on at the limit);
// - limit 0 = no limit, guard 0 = never held; a missing or stale status neither starves nor recovers.
// Expected numbers are computed by hand: 2 Mbit/s = 250,000 bytes/s.

const MB = 1024 * 1024;

/** A fake world: a clock moved by sleeps and by `advance`, and streams whose output time grows at the speed we set. */
function world(initial: { streamsOn?: number; capMbps?: number; guardMinutes?: number } = {}) {
  let now = 1_000_000;
  const load: LiveLoad = { streamsOn: initial.streamsOn ?? 1, capMbps: initial.capMbps ?? 2, guardMinutes: initial.guardMinutes ?? 3, encoders: [] };
  const streams = new Map<string, { speed: number; out: number; at: number; running: boolean; reported: number | null }>();
  const events: UploadBandwidthEvent[] = [];
  let slept = 0;
  const governor = createUploadBandwidthGovernor({
    clock: () => now,
    sleep: async (ms) => {
      slept += ms;
      tick(ms);
    },
    load: async () => ({
      ...load,
      encoders: [...streams.entries()].map(([channelId, s]): EncoderSample => ({ channelId, running: s.running, sampledAt: s.at, outTimeSeconds: s.out, speed: s.reported })),
    }),
    onEvent: (event) => void events.push(event),
  });
  /** Moves time on; every running stream sends `speed` seconds of output per second and writes a sample every 5 s. */
  function tick(ms: number) {
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, 5_000);
      now += step;
      left -= step;
      for (const s of streams.values()) {
        if (!s.running) continue;
        s.out += (step / 1000) * s.speed;
        s.at = now;
      }
    }
  }
  return {
    governor,
    load,
    events,
    stream(channelId: string, speed: number, options: { running?: boolean; reported?: number | null } = {}) {
      const existing = streams.get(channelId);
      streams.set(channelId, { speed, out: existing?.out ?? 0, at: existing?.at ?? now, running: options.running ?? true, reported: options.reported ?? speed });
    },
    freeze(channelId: string) {
      const s = streams.get(channelId)!;
      s.running = false;
    },
    advance: tick,
    /** Advances `ms` asking the governor every 5 s, as the runner does; returns what the last ask answered. */
    async run(ms: number): Promise<boolean> {
      let answer = true;
      for (let t = 0; t < ms; t += 5_000) {
        tick(5_000);
        answer = await governor.mayStart();
      }
      return answer;
    },
    now: () => now,
    slept: () => slept,
    reset: () => void (slept = 0),
  };
}

/** Sends `bytes` the way the gateway does: 64 KB slices, each paced first. Returns the seconds it took on the fake clock. */
async function send(w: ReturnType<typeof world>, bytes: number): Promise<number> {
  const start = w.now();
  for (let sent = 0; sent < bytes; sent += 64 * 1024) await w.governor.pace(Math.min(64 * 1024, bytes - sent));
  return (w.now() - start) / 1000;
}

test("a stream on and a 2 Mbit/s limit: the upload is held to 2 Mbit/s (10 MB in about 42 s)", async () => {
  const w = world({ capMbps: 2 });
  w.stream("UCjapan", 1);
  await w.governor.refresh(true);
  const seconds = await send(w, 10 * MB);
  // 10 MiB = 10,485,760 bytes at 250,000 bytes/s = 41.94 s; a quarter-second burst at most.
  assert.ok(seconds >= 41.9 - 0.3 && seconds <= 41.94 + 0.3, `took ${seconds} s`);
});

test("no stream on: the upload is not limited (no wait) and chunks keep their full size", async () => {
  const w = world({ streamsOn: 0, capMbps: 2 });
  await w.governor.refresh(true);
  assert.equal(await send(w, 10 * MB), 0);
  assert.equal(w.governor.chunkBytes(8 * MB), 8 * MB);
  assert.equal(await w.governor.mayStart(), true);
  assert.equal(w.governor.state().mode, "uncapped");
});

test("limit 0 means no limit even with streams on", async () => {
  const w = world({ capMbps: 0 });
  w.stream("UCjapan", 1);
  await w.governor.refresh(true);
  assert.equal(await send(w, 4 * MB), 0);
  assert.equal(w.governor.state().mode, "uncapped");
});

test("the limit engages and lets go mid-upload: a stream turned on during the upload slows the next slices", async () => {
  const w = world({ streamsOn: 0, capMbps: 2 });
  await w.governor.refresh(true);
  assert.equal(await send(w, 2 * MB), 0);
  w.load.streamsOn = 1;
  w.stream("UCjapan", 1);
  w.advance(5_000); // the next reading is due
  const limited = await send(w, 2 * MB);
  assert.ok(limited > 8, `limited part took ${limited} s (2 MiB at 250 kB/s = 8.4 s)`);
  w.load.streamsOn = 0;
  w.advance(5_000);
  assert.equal(await send(w, 2 * MB), 0);
});

test("limited chunks: whole 256 KB units of about a minute at the limit, never above the usual size, at least one unit", () => {
  // 2 Mbit/s: 250,000 B/s * 60 s = 15,000,000 B -> 57 units = 14,942,208 B, above 8 MiB -> 8 MiB.
  assert.equal(limitedChunkBytes(8 * MB, 250_000), 8 * MB);
  // 0.5 Mbit/s: 62,500 * 60 = 3,750,000 B -> 14 units = 3,670,016 B.
  assert.equal(limitedChunkBytes(8 * MB, 62_500), 14 * 256 * 1024);
  // 0.01 Mbit/s: 1,250 * 60 = 75,000 B -> less than a unit -> one unit.
  assert.equal(limitedChunkBytes(8 * MB, 1_250), 256 * 1024);
  assert.equal(limitedChunkBytes(8 * MB, null), 8 * MB);
});

test("a stream below 0.97x for 3 minutes holds the upload -- not before -- and the event names it", async () => {
  const w = world({ guardMinutes: 3 });
  w.stream("UCcuban", 0.676);
  w.stream("UCjapan", 0.995);
  // The first ask (after 5 s) already sees 0.676x (ffmpeg's figure until the 30-s window fills): the 3 minutes count from there.
  assert.equal(await w.run(3 * 60_000), true, "below for under 3 minutes: still sending");
  assert.equal(await w.run(5_000), false, "below for 3 minutes: held");
  assert.equal(w.governor.state().mode, "held");
  assert.equal(w.governor.state().heldForChannelId, "UCcuban");
  assert.equal(w.events[0]?.kind, "upload_held");
  assert.equal((w.events[0] as { channelId: string }).channelId, "UCcuban");
});

test("between 0.97x and 0.99x neither holds nor counts as recovered", async () => {
  const w = world({ guardMinutes: 1 });
  w.stream("UCcuban", 0.98);
  assert.equal(await w.run(10 * 60_000), true);
  assert.equal(w.events.length, 0);
});

test("recovery: all streams at 0.99x or more for a minute releases the hold; 0.98x does not", async () => {
  const w = world({ guardMinutes: 1 });
  w.stream("UCcuban", 0.5);
  assert.equal(await w.run(2 * 60_000), false);
  w.stream("UCcuban", 0.98);
  assert.equal(await w.run(3 * 60_000), false, "0.98x is not recovered");
  w.stream("UCcuban", 1);
  // The 90-s window still holds slow samples for a while; within 3 minutes of 1.0x the hold must be released.
  let released = false;
  for (let i = 0; i < 36 && !released; i += 1) released = await w.run(5_000);
  assert.equal(released, true);
  const release = w.events.find((e) => e.kind === "upload_released");
  assert.equal(release && release.kind === "upload_released" && release.reason, "recovered");
});

test("a hold never lasts more than 30 minutes; then the upload goes on at the limit and is not held again while still starving", async () => {
  const w = world({ guardMinutes: 3, capMbps: 2 });
  w.stream("UCcuban", 0.6);
  assert.equal(await w.run(4 * 60_000), false);
  const heldSince = w.governor.state().heldSince!;
  let free = false;
  while (!free) {
    free = await w.run(5_000);
    assert.ok(w.now() - heldSince <= HOLD_CEILING_MS + 5_000, "held past the ceiling");
  }
  assert.equal(w.governor.state().mode, "capped");
  assert.equal(await w.run(20 * 60_000), true, "still starving, but never held twice in a row");
  const release = w.events.find((e) => e.kind === "upload_released");
  assert.equal(release && release.kind === "upload_released" && release.reason, "ceiling");
  // Held, the chunk in flight still goes at the limit: pacing is the limit, not a stop.
  w.reset();
  const seconds = await send(w, 1 * MB);
  assert.ok(seconds > 4 && seconds < 4.5, `1 MiB at 250 kB/s = 4.19 s, took ${seconds}`);
});

test("guard 0: never held, however slow the stream", async () => {
  const w = world({ guardMinutes: 0 });
  w.stream("UCcuban", 0.3);
  assert.equal(await w.run(20 * 60_000), true);
  assert.equal(w.events.length, 0);
});

test("a stale or missing status neither starves nor recovers", async () => {
  const w = world({ guardMinutes: 1 });
  w.stream("UCcuban", 0.5);
  w.freeze("UCcuban"); // the helper stopped writing: a gap
  assert.equal(await w.run(10 * 60_000), true, "a gap never holds");
  const held = world({ guardMinutes: 1 });
  held.stream("UCcuban", 0.5);
  assert.equal(await held.run(2 * 60_000), false);
  held.freeze("UCcuban");
  assert.equal(await held.run(10 * 60_000), false, "a gap never releases (only the ceiling does)");
});

test("the stream stops: the hold ends at once and the upload is not limited", async () => {
  const w = world({ guardMinutes: 1 });
  w.stream("UCcuban", 0.5);
  assert.equal(await w.run(2 * 60_000), false);
  w.load.streamsOn = 0;
  assert.equal(await w.run(5_000), true);
  assert.equal(w.governor.state().mode, "uncapped");
  const release = w.events.find((e) => e.kind === "upload_released");
  assert.equal(release && release.kind === "upload_released" && release.reason, "no_stream");
});

test("the guard judges the last minute, not ffmpeg's average since the run began", async () => {
  // ffmpeg reports 0.95x (the average of a run that starved earlier) while the output now grows at 1.0x: not starving.
  const w = world({ guardMinutes: 1 });
  w.stream("UCjapan", 1, { reported: 0.95 });
  assert.equal(await w.run(5 * 60_000), true);
  assert.ok((w.governor.state().speeds.UCjapan ?? 0) >= 0.99);
});

test("a failed read of the streams keeps the last state; an upload is never stopped by it", async () => {
  let fail = false;
  let now = 0;
  const governor = createUploadBandwidthGovernor({
    clock: () => now,
    sleep: async (ms) => void (now += ms),
    load: async () => {
      if (fail) throw new Error("db locked");
      return { streamsOn: 0, capMbps: 2, guardMinutes: 3, encoders: [] };
    },
  });
  assert.equal(await governor.mayStart(), true);
  fail = true;
  now += 10_000;
  assert.equal(await governor.mayStart(), true);
  assert.equal(governor.state().mode, "uncapped");
});
