import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LIVE_STREAMS_SETTINGS, DomainError } from "./contracts";
import { createStreamSupervisor, drawPassOrder, encoderBitrateFor, playablePass, type HelperStatus, type SupervisorDependencies, type SupervisorStream, type ViewerSample } from "./supervisor";

// BL-176 acceptance for the server side of a running stream (LIVE_STREAMS_PLAN.md §3.1, §3.6–§3.8, §4.1 "Recovery";
// ADR 0036 §4–5). Fakes stand in for files, processes, YouTube and the store.

const KEY = "k3y-TEST-0000";
const A = "AAAAAAAAAA1";
const B = "BBBBBBBBBB2";
const C = "CCCCCCCCCC3";
const NOW = new Date("2026-10-12T12:00:00Z");

function harness(opts: { stream?: Partial<SupervisorStream>; playable?: string[]; enabled?: boolean; ingestion?: boolean; lifecycle?: string | null; spawnWritesStatus?: boolean; viewers?: number | null; sampleFails?: boolean } = {}) {
  const files = new Map<string, string>();
  const samples: ViewerSample[] = [];
  let viewerReads = 0;
  const events: Array<{ kind: string; detail: Record<string, unknown>; at?: string }> = [];
  const ours = new Set<number>();
  let strays = 0;
  const alive = new Set<number>();
  const signals: Array<[number, string]> = [];
  const spawned: Array<{ dir: string; key: string }> = [];
  let stream: SupervisorStream = {
    channelId: "UC1",
    intent: "on",
    streamId: "STREAM1",
    broadcastId: "BC1",
    orderMode: "sequence",
    passNumber: 0,
    passOrderJson: null,
    nextPassOrderJson: null,
    positionIndex: 0,
    positionOffsetSeconds: 0,
    ...opts.stream,
  };
  let playable = opts.playable ?? [A, B, C];
  let nextPid = 500;
  let clock = NOW.getTime();
  const syncs: Array<{ order: readonly string[]; currentIndex: number; nextPassFirst: string | null }> = [];

  const deps: SupervisorDependencies = {
    bufferRoot: "/appdata/live-streams",
    settings: async () => ({ ...DEFAULT_LIVE_STREAMS_SETTINGS, enabled: opts.enabled ?? true, host: { ok: true } }),
    streams: {
      get: async () => stream,
      update: async (_c, set) => {
        stream = { ...stream, ...(set as Partial<SupervisorStream>) };
        return true;
      },
      videos: async () => [A, B, C].map((videoId) => ({ videoId, originalPath: `04 Videos/${videoId}.mp4`, videoDurationSeconds: 7382, originalDurationSeconds: 7382.3 })),
      recheck: async () => playable,
      event: async (_c, kind, detail, at) => void events.push({ kind, detail, ...(at ? { at: at.toISOString() } : {}) }),
      sample: async (_c, sample) => {
        if (opts.sampleFails) throw new Error("SQLITE_BUSY");
        samples.push(sample);
      },
    },
    buffer: {
      sync: async (_c, args) => {
        syncs.push({ order: args.order, currentIndex: args.currentIndex, nextPassFirst: args.nextPassFirst });
        return { present: args.order.slice(args.currentIndex, args.currentIndex + 2), copied: [], removed: [], missing: null };
      },
      fileOf: (c, id) => `/appdata/live-streams/${c}/${id}.mp4`,
    },
    ffmpeg: async () => ({ ffmpegPath: "/opt/homebrew/bin/ffmpeg", ffprobePath: "/opt/homebrew/bin/ffprobe", features: { rtmps: true, h264Videotoolbox: true, libx264: true } }),
    youtube: {
      readIngestion: async () => (opts.ingestion === false ? null : { rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2", streamName: KEY }),
      readLifecycle: async () => (opts.lifecycle === null ? { found: false, lifeCycleStatus: null } : { found: true, lifeCycleStatus: opts.lifecycle ?? "live" }),
      readStreamHealth: async () => ({ streamStatus: "active", healthStatus: "ok", configurationIssues: [{ type: "bitrateLow", severity: "warning" }] }),
      readViewers: async () => {
        viewerReads += 1;
        return opts.viewers === undefined ? 7 : opts.viewers;
      },
    },
    files: {
      read: async (f) => files.get(f) ?? null,
      writeAtomic: async (f, t) => void files.set(f, t),
    },
    process: {
      spawnHelper: async (dir, key) => {
        spawned.push({ dir, key });
        const pid = nextPid++;
        alive.add(pid);
        ours.add(pid);
        // The real helper writes a "starting" status at once (with the token from plan.json).
        if (opts.spawnWritesStatus !== false) {
          files.set("/appdata/live-streams/UC1/status.json", JSON.stringify({ protocol: 1, token: "tok-1", pid, state: "starting", passNumber: 1, position: { index: 0, videoId: A, offset: 0 }, lastExit: null, progress: {}, updatedAt: clock }));
        }
        return pid;
      },
      isAlive: (pid) => alive.has(pid),
      isOurHelper: async (pid) => ours.has(pid),
      killStrayEncoders: async () => {
        const n = strays;
        strays = 0;
        return n;
      },
      signalGroup: (pid, sig) => {
        signals.push([pid, sig]);
        alive.delete(pid); // the fake helper exits at once
      },
      waitForExit: async (pid) => !alive.has(pid),
    },
    clock: () => new Date(clock),
    newToken: () => "tok-1",
    random: () => 0,
  };
  const status = (s: Partial<HelperStatus>) =>
    files.set(
      "/appdata/live-streams/UC1/status.json",
      JSON.stringify({ protocol: 1, token: "tok-1", pid: 500, state: "running", passNumber: 1, position: { index: 0, videoId: A, offset: 10 }, lastExit: null, progress: {}, updatedAt: clock, ...s })
    );
  return {
    deps,
    setStream: async (set: Partial<SupervisorStream>) => void (stream = { ...stream, ...set }),
    supervisor: createStreamSupervisor(deps),
    files,
    events,
    samples,
    viewerReads: () => viewerReads,
    alive,
    ours,
    signals,
    spawned,
    syncs,
    status,
    stream: () => stream,
    addStray: () => void (strays += 1),
    setPlayable: (p: string[]) => void (playable = p),
    advance: (ms: number) => void (clock += ms),
  };
}

test("drawPassOrder: sequence keeps the rotation order; shuffle permutes and does not start with the video that just ended", () => {
  assert.deepEqual(drawPassOrder([A, B, C], "sequence", () => 0, A), [A, B, C]);
  const shuffled = drawPassOrder([A, B, C], "shuffle", () => 0, null);
  assert.deepEqual([...shuffled].sort(), [A, B, C]);
  assert.notEqual(drawPassOrder([A, B, C], "shuffle", (n) => n - 1, A)[0], A);
});

test("playablePass: an unplayable video leaves the pass; a position on it moves to the next playable video at 0 s", () => {
  assert.deepEqual(playablePass([A, B, C], [A, C], { index: 2, offset: 50 }), { order: [A, C], index: 1, offset: 50 });
  assert.deepEqual(playablePass([A, B, C], [A, C], { index: 1, offset: 50 }), { order: [A, C], index: 1, offset: 0 });
  assert.deepEqual(playablePass([A, B, C], [A, B], { index: 2, offset: 50 }), { order: [A, B], index: 2, offset: 0 }, "past the end: a new pass is needed");
});

test("startEncoder: the key goes to the helper's stdin only; plan.json and helper.json never hold it", async () => {
  const h = harness();
  const { pid } = await h.supervisor.startEncoder("UC1", { freshPass: true });
  assert.deepEqual(h.spawned, [{ dir: "/appdata/live-streams/UC1", key: KEY }]);
  for (const [name, text] of h.files) assert.equal(text.split(KEY).length - 1, 0, name);
  const plan = JSON.parse(h.files.get("/appdata/live-streams/UC1/plan.json")!);
  assert.equal(plan.ingestUrl, "rtmps://a.rtmps.youtube.com/live2");
  assert.deepEqual(plan.pass.videos.map((v: { videoId: string }) => v.videoId), [A, B, C]);
  assert.deepEqual(JSON.parse(h.files.get("/appdata/live-streams/UC1/helper.json")!).pid, pid);
  assert.deepEqual([h.stream().passNumber, h.stream().positionIndex], [1, 0]);
  assert.equal(h.events.at(-1)?.kind, "encoder_start");
});

// BL-233 (FO-REQ-0047 ask 1): a stream's own bitrate overrides this computer's at encoder start; absent, the computer's is used.
// The computer's default is 6000 (DEFAULT_LIVE_STREAMS_SETTINGS); the stream's own value must be a whole 1000..12000.
test("BL-233: the stream's own bitrate goes to the encoder; without one the computer's setting does", async () => {
  const own = harness({ stream: { bitrateKbps: 4000 } });
  await own.supervisor.startEncoder("UC1", { freshPass: true });
  assert.equal(JSON.parse(own.files.get("/appdata/live-streams/UC1/plan.json")!).encoder.bitrateKbps, 4000);
  assert.deepEqual([own.events.at(-1)?.detail.bitrateKbps, own.events.at(-1)?.detail.bitrateSource], [4000, "stream"]);
  assert.equal(await own.supervisor.readPlanBitrateKbps("UC1"), 4000);

  const none = harness({ stream: { bitrateKbps: null } });
  await none.supervisor.startEncoder("UC1", { freshPass: true });
  assert.equal(JSON.parse(none.files.get("/appdata/live-streams/UC1/plan.json")!).encoder.bitrateKbps, 6000);
  assert.equal(none.events.at(-1)?.detail.bitrateSource, "computer");
});

test("BL-233: a stored stream bitrate outside 1000..12000 or not whole falls back to the computer's", () => {
  for (const bad of [999, 12001, 4000.5, Number.NaN, undefined, null]) {
    assert.deepEqual(encoderBitrateFor({ bitrateKbps: bad as number | null | undefined }, { bitrateKbps: 5000 }), { bitrateKbps: 5000, source: "computer" }, String(bad));
  }
  assert.deepEqual(encoderBitrateFor({ bitrateKbps: 1000 }, { bitrateKbps: 5000 }), { bitrateKbps: 1000, source: "stream" });
  assert.deepEqual(encoderBitrateFor({ bitrateKbps: 12000 }, { bitrateKbps: 5000 }), { bitrateKbps: 12000, source: "stream" });
});

test("startEncoder: a video that turned private is left out of the pass it hands the helper", async () => {
  const h = harness({ stream: { passNumber: 3, passOrderJson: JSON.stringify([A, B, C]), positionIndex: 1, positionOffsetSeconds: 300 }, playable: [A, C] });
  await h.supervisor.startEncoder("UC1", { freshPass: false });
  const plan = JSON.parse(h.files.get("/appdata/live-streams/UC1/plan.json")!);
  assert.deepEqual(plan.pass.videos.map((v: { videoId: string }) => v.videoId), [A, C]);
  assert.deepEqual([plan.pass.number, plan.pass.startIndex, plan.pass.startOffset], [3, 1, 0], "B was playing: resume at C from its start");
  assert.deepEqual(plan.playable, [A, C]);
});

test("startEncoder refuses, starting nothing, when the module is off, the stream is not on, nothing is playable or YouTube gives no key", async () => {
  const cases: Array<[Parameters<typeof harness>[0], string]> = [
    [{ enabled: false }, "live_streams_host_unsupported"],
    [{ stream: { intent: "off" } }, "validation_failed"],
    [{ playable: [] }, "live_stream_video_refused"],
    [{ ingestion: false }, "validation_failed"],
  ];
  for (const [options, code] of cases) {
    const h = harness(options);
    await assert.rejects(() => h.supervisor.startEncoder("UC1", { freshPass: true }), (e: unknown) => e instanceof DomainError && e.code === code, JSON.stringify(options));
    assert.equal(h.spawned.length, 0);
  }
});

test("adoption: a running helper is adopted only with its pid alive, its token and pid in a fresh status", async () => {
  const h = harness();
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({});
  assert.ok(await h.supervisor.runningHelper("UC1"));
  h.status({ token: "someone-else" });
  assert.equal(await h.supervisor.runningHelper("UC1"), null, "token mismatch");
  h.status({});
  h.advance(3 * 60_000);
  assert.equal(await h.supervisor.runningHelper("UC1"), null, "stale status: hung, not running");
  h.status({});
  h.alive.clear();
  assert.equal(await h.supervisor.runningHelper("UC1"), null, "pid gone");
});

test("startEncoder refuses while a helper is already running (no second encoder)", async () => {
  const h = harness();
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({});
  await assert.rejects(() => h.supervisor.startEncoder("UC1", { freshPass: false }), (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  assert.equal(h.spawned.length, 1);
});

test("stopEncoder signals only a process proven ours by its command line (a reused pid is left alone), the whole group", async () => {
  const h = harness();
  const { pid } = await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.ours.delete(pid); // after a reboot the number belongs to another process
  assert.equal(await h.supervisor.stopEncoder("UC1", "owner"), false);
  assert.deepEqual(h.signals, []);
  h.ours.add(pid);
  assert.equal(await h.supervisor.stopEncoder("UC1", "owner"), true);
  assert.deepEqual(h.signals, [[pid, "SIGTERM"]]);
});

test("tick: carries the position into the database, draws the next pass on the last video, and follows the helper's pass", async () => {
  const h = harness({ stream: { orderMode: "sequence" } });
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({ passVideoIds: [A, B, C], position: { index: 1, videoId: B, offset: 120 } });
  await h.supervisor.tick("UC1");
  assert.deepEqual([h.stream().positionIndex, h.stream().positionOffsetSeconds, h.stream().nextPassOrderJson], [1, 120, null]);

  h.status({ passVideoIds: [A, B, C], position: { index: 2, videoId: C, offset: 5 } });
  await h.supervisor.tick("UC1");
  assert.equal(h.stream().nextPassOrderJson, JSON.stringify([A, B, C]));
  const plan = JSON.parse(h.files.get("/appdata/live-streams/UC1/plan.json")!);
  assert.equal(plan.nextPass.number, 2);
  assert.deepEqual(h.syncs.at(-1), { order: [A, B, C], currentIndex: 2, nextPassFirst: A }, "the buffer copies the next pass's first video");

  h.status({ passNumber: 2, passVideoIds: [A, B, C], position: { index: 0, videoId: A, offset: 3 } });
  await h.supervisor.tick("UC1");
  assert.deepEqual([h.stream().passNumber, h.stream().nextPassOrderJson, h.stream().positionIndex], [2, null, 0]);
});

test("tick: a pass the helper started without a drawn next pass (server was down) is adopted too, with its own order", async () => {
  const h = harness();
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  // The helper replayed the order without A (no longer playable) as pass 2, while the record still says pass 1.
  h.status({ passNumber: 2, passVideoIds: [B, C], position: { index: 0, videoId: B, offset: 30 } });
  await h.supervisor.tick("UC1");
  assert.deepEqual([h.stream().passNumber, h.stream().passOrderJson, h.stream().positionIndex], [2, JSON.stringify([B, C]), 0]);
  assert.deepEqual(h.syncs.at(-1)?.order, [B, C], "the buffer follows what is really played");
});

test("tick imports the helper's events once, prefixed encoder_", async () => {
  const h = harness();
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({});
  h.files.set("/appdata/live-streams/UC1/events.jsonl", `${JSON.stringify({ at: 1, kind: "run_start", index: 0 })}\n${JSON.stringify({ at: 2, kind: "run_exit", cause: "encoder_exit" })}\n`);
  await h.supervisor.tick("UC1");
  await h.supervisor.tick("UC1");
  assert.deepEqual(h.events.filter((e) => e.kind.startsWith("encoder_run")).map((e) => e.kind), ["encoder_run_start", "encoder_run_exit"]);
});

test("§3.8: a broadcast YouTube ended stops the encoder, turns the intent off, records it -- no write", async () => {
  const h = harness({ lifecycle: "complete" });
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({});
  const result = await h.supervisor.checkBroadcast("UC1");
  assert.deepEqual(result, { lifeCycleStatus: "complete", endedByYoutube: true });
  assert.deepEqual(h.signals, [[500, "SIGTERM"]]);
  assert.equal(h.stream().intent, "off");
  assert.equal(h.events.at(-1)?.kind, "youtube_ended");
});

test("§3.8: a live broadcast is left alone; §3.10 the poll keeps health, issue types and viewers (no key, no URL)", async () => {
  const h = harness({ lifecycle: "live" });
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({});
  assert.deepEqual(await h.supervisor.checkBroadcast("UC1"), { lifeCycleStatus: "live", endedByYoutube: false });
  assert.deepEqual(h.signals, []);
  assert.equal(h.stream().intent, "on");
  const poll = await h.supervisor.lastYoutubePoll("UC1");
  assert.deepEqual(poll, { checkedAt: NOW.getTime(), lifeCycleStatus: "live", notLiveSince: null, streamStatus: "active", healthStatus: "ok", configurationIssues: [{ type: "bitrateLow", severity: "warning" }], viewers: 7 });
});

test("§3.10: a broadcast not live keeps the time it was first seen not live across polls", async () => {
  const h = harness({ lifecycle: "ready" });
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({});
  await h.supervisor.checkBroadcast("UC1");
  h.advance(5 * 60_000);
  h.status({});
  await h.supervisor.checkBroadcast("UC1");
  const poll = await h.supervisor.lastYoutubePoll("UC1");
  assert.deepEqual([poll?.lifeCycleStatus, poll?.notLiveSince, poll?.viewers], ["ready", NOW.getTime(), null]);
  assert.equal(h.events.filter((e) => e.kind === "youtube_status").length, 1, "a status change is recorded once");
});

// --- Independent review (2026-10-12): never two encoders on one key; strays and hung helpers are stopped first. ---

test("two starts at the same time (Start and a background tick) spawn ONE encoder; the other is refused as already running", async () => {
  const h = harness();
  const results = await Promise.allSettled([h.supervisor.startEncoder("UC1", { freshPass: true }), h.supervisor.startEncoder("UC1", { freshPass: false })]);
  assert.equal(h.spawned.length, 1);
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
});

test("a hung helper (alive, ours, no status for a minute) is stopped -- with its group -- before a new one starts", async () => {
  const h = harness();
  const first = await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.advance(2 * 60_000); // its status is now stale
  const second = await h.supervisor.startEncoder("UC1", { freshPass: false });
  assert.notEqual(first.pid, second.pid);
  assert.deepEqual(h.signals, [[first.pid, "SIGTERM"]]);
  assert.equal(h.alive.has(first.pid), false);
  assert.ok(h.events.some((e) => e.kind === "encoder_stop" && e.detail.reason === "hung"));
});

test("a live pid that is not our helper (reused) is neither stopped nor taken as running", async () => {
  const h = harness();
  const { pid } = await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.ours.delete(pid);
  assert.equal(await h.supervisor.runningHelper("UC1"), null);
  await h.supervisor.startEncoder("UC1", { freshPass: false });
  assert.deepEqual(h.signals, [], "the stranger is not signalled");
});

test("§3.8: a broadcast YouTube no longer has (deleted in Studio) counts as ended: encoder stopped, intent off, no write", async () => {
  const h = harness({ lifecycle: null });
  const { pid } = await h.supervisor.startEncoder("UC1", { freshPass: true });
  assert.deepEqual(await h.supervisor.checkBroadcast("UC1"), { lifeCycleStatus: "not_found", endedByYoutube: true });
  assert.deepEqual(h.signals, [[pid, "SIGTERM"]]);
  assert.equal(h.stream().intent, "off");
});

test("Restart rebuilds the pass from the rotation as it is now; the video playing keeps its place and offset", async () => {
  const h = harness({ stream: { passNumber: 4, passOrderJson: JSON.stringify([A, B]), positionIndex: 1, positionOffsetSeconds: 300 }, playable: [C, B, A] });
  await h.supervisor.startEncoder("UC1", { freshPass: false });
  await h.supervisor.restart("UC1");
  const plan = JSON.parse(h.files.get("/appdata/live-streams/UC1/plan.json")!);
  assert.deepEqual(plan.pass.videos.map((v: { videoId: string }) => v.videoId), [C, B, A], "the new rotation order");
  assert.deepEqual([plan.pass.startIndex, plan.pass.startOffset], [1, 300], "B keeps playing from 300 s");
  assert.equal(h.spawned.length, 2);
});

test("rebuiltPass: shuffle puts the video playing first; a video no longer in the rotation starts the pass from the top", async () => {
  const { rebuiltPass } = await import("./supervisor");
  assert.deepEqual(rebuiltPass([A, B, C], "shuffle", () => 0, { videoId: B, offset: 50 }).order[0], B);
  assert.deepEqual(rebuiltPass([A, C], "sequence", () => 0, { videoId: B, offset: 50 }), { order: [A, C], index: 0, offset: 0 });
});

test("the helper's events keep their own times when imported", async () => {
  const h = harness();
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({});
  h.files.set("/appdata/live-streams/UC1/events.jsonl", `${JSON.stringify({ at: Date.parse("2026-10-12T03:00:00Z"), kind: "run_exit", cause: "encoder_exit" })}\n`);
  await h.supervisor.tick("UC1");
  assert.equal(h.events.find((e) => e.kind === "encoder_run_exit")?.at, "2026-10-12T03:00:00.000Z");
});

// --- Verification review (2026-10-12) ---

test("a helper spawned moments ago whose first status is not written yet counts as starting: a second start is refused, nothing killed", async () => {
  const h = harness({ spawnWritesStatus: false });
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  await assert.rejects(() => h.supervisor.startEncoder("UC1", { freshPass: false }), (e: unknown) => e instanceof DomainError && /starting/.test(e.message));
  assert.deepEqual(h.signals, []);
  assert.equal(h.spawned.length, 1);
});

test("an ffmpeg left behind by a helper killed outright is killed before a new encoder starts", async () => {
  const h = harness();
  h.addStray();
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  assert.ok(h.events.some((e) => e.kind === "encoder_stop" && e.detail.reason === "stray"));
});

test("Stop pressed while a start fills the buffer: the start does not spawn (the intent is re-read under the lock)", async () => {
  const h = harness();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const original = h.deps.buffer.sync;
  h.deps.buffer.sync = async (c, args) => {
    await gate;
    return original(c, args);
  };
  const starting = h.supervisor.startEncoder("UC1", { freshPass: true });
  await h.setStream({ intent: "off" });
  release();
  await assert.rejects(() => starting, (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  assert.equal(h.spawned.length, 0);
});

test("a check of the encoder process that fails (ps) is an error, never 'no encoder' (no second encoder beside a running one)", async () => {
  const h = harness();
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.deps.process.isOurHelper = async () => {
    throw new Error("could not check the encoder process");
  };
  await assert.rejects(() => h.supervisor.startEncoder("UC1", { freshPass: false }), /could not check/);
  assert.equal(h.spawned.length, 1);
});

// --- Final check (2026-10-12) ---

test("Stop with no helper left still stops an ffmpeg that kept sending after its helper was killed outright", async () => {
  const h = harness();
  h.addStray();
  assert.equal(await h.supervisor.stopEncoder("UC1", "owner_stop"), true);
  assert.ok(h.events.some((e) => e.kind === "encoder_stop" && e.detail.reason === "stray"));
  assert.equal(await h.supervisor.stopEncoder("UC1", "owner_stop"), false, "nothing left to stop");
});

test("Restart fills the buffer before taking the stream's lock: a Stop during the copy does not wait for it, and the restart then starts nothing", async () => {
  const h = harness();
  const { pid } = await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({ pid });
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const copying = new Promise<void>((r) => (entered = r));
  const original = h.deps.buffer.sync;
  h.deps.buffer.sync = async (c, args) => {
    entered();
    await gate;
    return original(c, args);
  };
  const restarting = h.supervisor.restart("UC1");
  await copying; // the restart is now inside its buffer copy
  await h.setStream({ intent: "off" });
  assert.equal(await h.supervisor.stopEncoder("UC1", "owner_stop"), true, "Stop finished while the copy was still running");
  assert.deepEqual(h.signals, [[pid, "SIGTERM"]]);
  release();
  await assert.rejects(() => restarting, (e: unknown) => e instanceof DomainError && e.code === "validation_failed");
  assert.equal(h.spawned.length, 1, "no encoder after the Stop");
});

test("Restart starts from the position as it is when the encoder stops, not as it was before the buffer copy", async () => {
  const h = harness({ stream: { passNumber: 4, passOrderJson: JSON.stringify([A, B, C]), positionIndex: 0, positionOffsetSeconds: 100 } });
  const { pid } = await h.supervisor.startEncoder("UC1", { freshPass: false });
  h.status({ pid });
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const copying = new Promise<void>((r) => (entered = r));
  const original = h.deps.buffer.sync;
  h.deps.buffer.sync = async (c, args) => {
    entered();
    await gate;
    return original(c, args);
  };
  const restarting = h.supervisor.restart("UC1");
  await copying; // the restart is now inside its buffer copy
  await h.setStream({ positionIndex: 1, positionOffsetSeconds: 42 }); // the helper moved on to B meanwhile
  release();
  await restarting;
  const plan = JSON.parse(h.files.get("/appdata/live-streams/UC1/plan.json")!);
  assert.deepEqual([plan.pass.videos[plan.pass.startIndex].videoId, plan.pass.startOffset], [B, 42]);
});

// --- BL-211 (LIVE_ANALYTICS_PLAN.md stage 1; owner msgs 3360-3369): every completed broadcast poll is kept as a sample. ---

test("BL-211: a live poll keeps one sample with what it read -- viewers, lifecycle, stream status, health -- and makes no extra viewers read", async () => {
  const h = harness({ lifecycle: "live" });
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({});
  await h.supervisor.checkBroadcast("UC1");
  assert.deepEqual(h.samples, [{ sampledAt: NOW, broadcastId: "BC1", viewers: 7, lifeCycleStatus: "live", streamStatus: "active", healthStatus: "ok" }]);
  assert.equal(h.viewerReads(), 1);
  h.advance(5 * 60_000);
  h.status({});
  await h.supervisor.checkBroadcast("UC1");
  assert.deepEqual(h.samples.map((s) => s.sampledAt.getTime()), [NOW.getTime(), NOW.getTime() + 300_000]);
  assert.equal(h.viewerReads(), 2, "one viewers read per poll, as before");
});

test("BL-211: no count from YouTube is kept as viewers null, never 0", async () => {
  const h = harness({ lifecycle: "live", viewers: null });
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({});
  await h.supervisor.checkBroadcast("UC1");
  assert.equal(h.samples.length, 1);
  assert.equal(h.samples[0].viewers, null);
});

test("BL-211: a broadcast that is not live yet (ready) is sampled with viewers null and no viewers read", async () => {
  const h = harness({ lifecycle: "ready" });
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({});
  await h.supervisor.checkBroadcast("UC1");
  assert.deepEqual(h.samples, [{ sampledAt: NOW, broadcastId: "BC1", viewers: null, lifeCycleStatus: "ready", streamStatus: "active", healthStatus: "ok" }]);
  assert.equal(h.viewerReads(), 0);
});

test("BL-211: no sample when YouTube ended the broadcast (the event records it) or when the stream has no broadcast", async () => {
  for (const lifecycle of ["complete", "revoked", null]) {
    const h = harness({ lifecycle });
    await h.supervisor.startEncoder("UC1", { freshPass: true });
    h.status({});
    await h.supervisor.checkBroadcast("UC1");
    assert.deepEqual(h.samples, [], String(lifecycle));
  }
  const none = harness({ stream: { broadcastId: null } });
  assert.deepEqual(await none.supervisor.checkBroadcast("UC1"), { lifeCycleStatus: null, endedByYoutube: false });
  assert.deepEqual(none.samples, []);
});

test("BL-211: a sample that cannot be written never breaks the poll -- result, poll file and status event stay as without it", async () => {
  const h = harness({ lifecycle: "live", sampleFails: true });
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({});
  assert.deepEqual(await h.supervisor.checkBroadcast("UC1"), { lifeCycleStatus: "live", endedByYoutube: false });
  assert.equal((await h.supervisor.lastYoutubePoll("UC1"))?.viewers, 7);
  assert.ok(h.events.some((e) => e.kind === "youtube_status"));
  assert.deepEqual(h.events.filter((e) => e.kind === "viewer_sample_failed").map((e) => e.detail), [{ broadcastId: "BC1" }]);
  assert.equal(h.stream().intent, "on");
});
