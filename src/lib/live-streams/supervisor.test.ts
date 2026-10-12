import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LIVE_STREAMS_SETTINGS, DomainError } from "./contracts";
import { createStreamSupervisor, drawPassOrder, playablePass, type HelperStatus, type SupervisorDependencies, type SupervisorStream } from "./supervisor";

// BL-176 acceptance for the server side of a running stream (LIVE_STREAMS_PLAN.md §3.1, §3.6–§3.8, §4.1 "Recovery";
// ADR 0036 §4–5). Fakes stand in for files, processes, YouTube and the store.

const KEY = "k3y-TEST-0000";
const A = "AAAAAAAAAA1";
const B = "BBBBBBBBBB2";
const C = "CCCCCCCCCC3";
const NOW = new Date("2026-10-12T12:00:00Z");

function harness(opts: { stream?: Partial<SupervisorStream>; playable?: string[]; enabled?: boolean; ingestion?: boolean; lifecycle?: string } = {}) {
  const files = new Map<string, string>();
  const events: Array<{ kind: string; detail: Record<string, unknown> }> = [];
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
      event: async (_c, kind, detail) => void events.push({ kind, detail }),
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
      readLifecycle: async () => opts.lifecycle ?? "live",
      readStreamHealth: async () => ({ streamStatus: "active", healthStatus: "ok", configurationIssues: [{ type: "bitrateLow", severity: "warning" }] }),
      readViewers: async () => 7,
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
        return pid;
      },
      isAlive: (pid) => alive.has(pid),
      signal: (pid, sig) => void signals.push([pid, sig]),
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
    supervisor: createStreamSupervisor(deps),
    files,
    events,
    alive,
    signals,
    spawned,
    syncs,
    status,
    stream: () => stream,
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

test("stopEncoder signals only a process proven ours by its token", async () => {
  const h = harness();
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({ token: "someone-else" });
  assert.equal(await h.supervisor.stopEncoder("UC1", "owner"), false);
  assert.deepEqual(h.signals, []);
  h.status({});
  assert.equal(await h.supervisor.stopEncoder("UC1", "owner"), true);
  assert.deepEqual(h.signals, [[500, "SIGTERM"]]);
});

test("tick: carries the position into the database, draws the next pass on the last video, and adopts it when the helper moves on", async () => {
  const h = harness({ stream: { orderMode: "sequence" } });
  await h.supervisor.startEncoder("UC1", { freshPass: true });
  h.status({ position: { index: 1, videoId: B, offset: 120 } });
  await h.supervisor.tick("UC1");
  assert.deepEqual([h.stream().positionIndex, h.stream().positionOffsetSeconds, h.stream().nextPassOrderJson], [1, 120, null]);

  h.status({ position: { index: 2, videoId: C, offset: 5 } });
  await h.supervisor.tick("UC1");
  assert.equal(h.stream().nextPassOrderJson, JSON.stringify([A, B, C]));
  const plan = JSON.parse(h.files.get("/appdata/live-streams/UC1/plan.json")!);
  assert.equal(plan.nextPass.number, 2);
  assert.deepEqual(h.syncs.at(-1), { order: [A, B, C], currentIndex: 2, nextPassFirst: A }, "the buffer copies the next pass's first video");

  h.status({ passNumber: 2, position: { index: 0, videoId: A, offset: 3 } });
  await h.supervisor.tick("UC1");
  assert.deepEqual([h.stream().passNumber, h.stream().nextPassOrderJson, h.stream().positionIndex], [2, null, 0]);
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
