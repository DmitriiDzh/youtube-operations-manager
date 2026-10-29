import assert from "node:assert/strict";
import test from "node:test";
import {
  createUploadBandwidthGovernor,
  HOLD_CEILING_MS,
  limitedChunkBytes,
  newGuardMemory,
  stepGuard,
  uploadBandwidthReport,
  uploadBandwidthStatus,
  registerUploadBandwidthGovernor,
  type EncoderSample,
  type LiveLoad,
  type UploadBandwidthEvent,
} from "./governor";

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

test("the report: held / limited / none in codes, times in ISO, speeds only while an upload is under way", () => {
  const base = { capMbps: 2, guardMinutes: 3, streamsOn: 2, heldForChannelId: null, ceilingReleasedAt: null, speeds: { UCc: 0.6764 }, evaluatedAt: 0, lastAskedAt: 0 };
  assert.equal(uploadBandwidthReport(null), null);
  const held = uploadBandwidthReport({ ...base, mode: "held", heldSince: Date.UTC(2026, 9, 29, 14, 10), heldForChannelId: "UCc", uploadActive: true })!;
  assert.deepEqual([held.limit, held.heldSince, held.heldForChannelId, held.speeds.UCc, held.active], ["held", "2026-10-29T14:10:00.000Z", "UCc", 0.676, true]);
  assert.equal(uploadBandwidthReport({ ...base, mode: "capped", heldSince: null, uploadActive: false })!.limit, "limited");
  assert.deepEqual(uploadBandwidthReport({ ...base, mode: "uncapped", heldSince: null, uploadActive: false })!.speeds, {});
});

test("a held upload is released as recovered only when the stream it was held for is back -- not while that stream is in a gap", async () => {
  const w = world({ guardMinutes: 1 });
  w.stream("UCa", 0.5);
  w.stream("UCb", 1);
  assert.equal(await w.run(2 * 60_000), false);
  assert.equal(w.governor.state().heldForChannelId, "UCa");
  w.freeze("UCa"); // its encoder reconnects: a gap
  assert.equal(await w.run(5 * 60_000), false, "the other stream keeping up does not release the hold");
  w.stream("UCa", 1); // back, and keeping up
  let released = false;
  for (let i = 0; i < 36 && !released; i += 1) released = await w.run(5_000);
  assert.equal(released, true);
  const release = w.events.find((e) => e.kind === "upload_released");
  assert.equal(release && release.kind === "upload_released" && release.reason, "recovered");
});

test("an upload sending a long limited chunk stays active for the readers; 30 s without an ask or a slice it is not", async () => {
  const w = world({ capMbps: 2 });
  w.stream("UCa", 1);
  registerUploadBandwidthGovernor(w.governor);
  await w.governor.mayStart();
  // 45 s of sending one chunk at the limit (about 11 MB at 250 kB/s), no ask in between.
  await send(w, 11_250_000);
  assert.equal(uploadBandwidthStatus(w.now())?.uploadActive, true);
  w.advance(31_000);
  assert.equal(uploadBandwidthStatus(w.now())?.uploadActive, false);
});

// Independent review of BL-233 (2026-10-29). The helper writes a status on every ffmpeg progress block (every 5 s) AND a heartbeat
// every 10 s that repeats the last progress with a fresh write time. A 1.00x stream must read about 1.00 either way.
function heartbeatRun(options: { stamped: boolean; heartbeatOffsetS: number; speed: number; seconds: number }) {
  const memory = newGuardMemory();
  const speeds: number[] = [];
  const t0 = 1_000_000;
  for (let t = 100; t < options.seconds; t += 5) {
    const lastProgress = Math.floor(t / 5) * 5; // ffmpeg's last block
    const lastHeartbeat = Math.floor((t - options.heartbeatOffsetS) / 10) * 10 + options.heartbeatOffsetS;
    const writtenAt = Math.max(lastProgress, lastHeartbeat);
    const sample = {
      channelId: "UCa",
      intentOn: true,
      running: true,
      sampledAt: t0 + writtenAt * 1000,
      progressAt: options.stamped ? t0 + lastProgress * 1000 : null,
      outTimeSeconds: lastProgress * options.speed,
      speed: options.speed,
    };
    const step = stepGuard(memory, { streamsOn: 1, capMbps: 2, guardMinutes: 3, encoders: [sample] }, t0 + t * 1000 + 300);
    if (t > 200) speeds.push(step.speeds.UCa ?? Number.NaN);
  }
  return speeds;
}

test("review: heartbeat rewrites do not skew the recent speed -- stamped progress, and old helpers without the stamp", () => {
  for (const stamped of [true, false]) {
    for (const offset of [1, 2.5, 4, 4.9]) {
      const speeds = heartbeatRun({ stamped, heartbeatOffsetS: offset, speed: 1, seconds: 2_000 });
      assert.ok(speeds.every((v) => v >= 0.99 && v <= 1.01), `stamped=${stamped} offset=${offset}: ${Math.min(...speeds)}..${Math.max(...speeds)}`);
    }
  }
  // A real 0.9x stream still reads as starving.
  assert.ok(heartbeatRun({ stamped: true, heartbeatOffsetS: 2.5, speed: 0.9, seconds: 600 }).every((v) => Math.abs(v - 0.9) < 0.005));
});

test("review: an output time that stops moving still reads as a stall, stamped or not", () => {
  const memory = newGuardMemory();
  const t0 = 5_000_000;
  let last = 0;
  for (let t = 0; t <= 300; t += 5) {
    const out = t <= 120 ? t : 120; // ffmpeg stalls at 120 s (a dead link): progress blocks keep coming with the same out_time
    last = stepGuard(memory, { streamsOn: 1, capMbps: 2, guardMinutes: 1, encoders: [{ channelId: "UCa", intentOn: true, running: true, sampledAt: t0 + t * 1000, progressAt: null, outTimeSeconds: out, speed: 1 }] }, t0 + t * 1000).speeds.UCa ?? 1;
  }
  assert.ok(last < 0.5, `stalled stream read ${last}`);
});

test("review: a hold ends when the stream it was held for is turned off or no longer listed, while another stream runs", async () => {
  for (const how of ["off", "gone"] as const) {
    let encoders: EncoderSample[] = [];
    let now = 0;
    const events: UploadBandwidthEvent[] = [];
    const governor = createUploadBandwidthGovernor({
      clock: () => now,
      sleep: async (ms) => void (now += ms),
      load: async () => ({ streamsOn: encoders.filter((e) => e.intentOn !== false).length, capMbps: 2, guardMinutes: 1, encoders }),
      onEvent: (e) => void events.push(e),
    });
    const sample = (channelId: string, out: number, speed: number, intentOn = true): EncoderSample => ({ channelId, intentOn, running: intentOn, sampledAt: now, progressAt: now, outTimeSeconds: out, speed });
    for (let t = 0; t <= 120; t += 5) {
      now = t * 1000;
      encoders = [sample("UCa", t * 0.5, 0.5), sample("UCb", t, 1)];
      await governor.mayStart();
    }
    assert.equal(governor.state().heldForChannelId, "UCa");
    now += 5_000;
    encoders = how === "off" ? [sample("UCa", 60, 0.5, false), sample("UCb", 125, 1)] : [sample("UCb", 125, 1)];
    assert.equal(await governor.mayStart(), true, how);
    const release = events.find((e) => e.kind === "upload_released");
    assert.equal(release && release.kind === "upload_released" && release.reason, "stream_off", how);
  }
});

test("review: a failed read while held still ends the hold at the 30-minute ceiling", async () => {
  let fail = false;
  let now = 0;
  let out = 0;
  const events: UploadBandwidthEvent[] = [];
  const governor = createUploadBandwidthGovernor({
    clock: () => now,
    sleep: async (ms) => void (now += ms),
    load: async () => {
      if (fail) throw new Error("db locked");
      return { streamsOn: 1, capMbps: 2, guardMinutes: 1, encoders: [{ channelId: "UCa", intentOn: true, running: true, sampledAt: now, progressAt: now, outTimeSeconds: out, speed: 0.5 }] };
    },
    onEvent: (e) => void events.push(e),
  });
  for (; now <= 120_000; now += 5_000, out += 2.5) await governor.mayStart();
  assert.equal(governor.state().mode, "held");
  const heldSince = governor.state().heldSince!;
  fail = true;
  let free = false;
  while (!free && now < heldSince + 40 * 60_000) {
    now += 5_000;
    free = await governor.mayStart();
  }
  assert.equal(free, true, "released despite the failed reads");
  assert.ok(now - heldSince <= HOLD_CEILING_MS + 5_000);
  const release = events.find((e) => e.kind === "upload_released");
  assert.equal(release && release.kind === "upload_released" && release.reason, "ceiling");
});

test("review: no upload for 30 s forgets the hold; the next upload is not held on the first upload's old timings", async () => {
  const w = world({ guardMinutes: 3 });
  // Upload A: the stream sends at 0.5x for 2.5 minutes (not yet 3): belowSince is set.
  w.stream("UCa", 0.5, { reported: 0.5 });
  assert.equal(await w.run(150_000), true);
  // No upload asks for 10 minutes; the stream is fine again, but ffmpeg's run average still reads 0.95.
  w.stream("UCa", 1, { reported: 0.95 });
  w.advance(10 * 60_000);
  // Upload B: never held in its first 3 minutes on A's old timing.
  assert.equal(await w.governor.mayStart(), true);
  assert.equal(await w.run(3 * 60_000), true);
  assert.equal(w.events.filter((e) => e.kind === "upload_held").length, 0);

  // A held upload that is cancelled leaves no hold behind: the next ask, 31 s later, starts afresh.
  const h = world({ guardMinutes: 1 });
  h.stream("UCa", 0.5);
  assert.equal(await h.run(2 * 60_000), false);
  h.stream("UCa", 1, { reported: 1 });
  h.advance(31_000);
  assert.equal(await h.governor.mayStart(), true);
  assert.equal(h.governor.state().heldSince, null);
  const release = h.events.find((e) => e.kind === "upload_released");
  assert.equal(release && release.kind === "upload_released" && release.reason, "no_upload");
});
