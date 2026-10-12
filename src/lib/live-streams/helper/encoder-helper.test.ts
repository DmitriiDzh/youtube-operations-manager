import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runHelper } from "./encoder-helper.mjs";

// BL-176 acceptance for the encoder helper (LIVE_STREAMS_PLAN.md §3.6, §3.5 "Replaying", §4.1 "Recovery"/"Scrubber"),
// with a scripted fake ffmpeg and in-memory files: the expected behaviour comes from the plan, not from the helper.

const KEY = "k3y-TEST-0000";

type Step = { progress?: number[]; stderr?: string[]; exit: { code: number | null; signal?: string | null } };

function harness(opts: {
  steps: Step[];
  files: string[];
  plan: Record<string, unknown> | ((spawned: number) => Record<string, unknown>);
  onProbe?: (signal: { stopped: boolean; onStop?: () => void; wake?: () => void }) => void;
  keyframe?: (file: string, offset: number) => number | null;
  stopAfterRuns?: number;
  stopAfterSleeps?: number;
}) {
  const written: Record<string, string> = {};
  const statuses: Array<Record<string, unknown>> = [];
  const appended: Record<string, string> = {};
  const runs: Array<{ args: string[]; list: string }> = [];
  const sleeps: number[] = [];
  const signal: { stopped: boolean; onStop?: () => void; wake?: () => void } = { stopped: false };
  let clock = 1_000_000;
  let stepIndex = 0;

  const io = {
    readPlan: () => (typeof opts.plan === "function" ? opts.plan(runs.length) : opts.plan),
    exists: (file: string) => opts.files.includes(file),
    writeAtomic: (name: string, text: string) => {
      written[name] = text;
      if (name === "status.json") statuses.push(JSON.parse(text));
    },
    append: (name: string, text: string) => void (appended[name] = (appended[name] ?? "") + text),
    spawnFfmpeg: (_path: string, args: string[]) => {
      runs.push({ args, list: written["run.ffconcat"] });
      const step = opts.steps[stepIndex++] ?? { exit: { code: 0 } };
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
      setImmediate(() => {
        for (const line of step.stderr ?? []) child.stderr.write(`${line}\n`);
        for (const t of step.progress ?? []) child.stdout.write(`out_time_us=${Math.round(t * 1e6)}\nbitrate=2200.0kbits/s\nprogress=continue\n`);
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => {
          clock += Math.round((step.progress?.at(-1) ?? 0) * 1000);
          if (opts.stopAfterRuns !== undefined && runs.length >= opts.stopAfterRuns) signal.stopped = true;
          child.emit("exit", step.exit.code, step.exit.signal ?? null);
        });
      });
      return child;
    },
    probeKeyframe: async (_p: string, file: string, offset: number) => {
      opts.onProbe?.(signal);
      return opts.keyframe ? opts.keyframe(file, offset) : offset;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      if (opts.stopAfterSleeps !== undefined && sleeps.length >= opts.stopAfterSleeps) signal.stopped = true;
    },
    now: () => clock,
  };
  return { run: () => runHelper({ dir: "/buf/UC1", key: KEY, pid: 4242, io: io as never, signal }), written, statuses, appended, runs, sleeps, signal };
}

const A = { videoId: "AAAAAAAAAA1", file: "/buf/UC1/AAAAAAAAAA1.mp4", duration: 10 };
const B = { videoId: "BBBBBBBBBB2", file: "/buf/UC1/BBBBBBBBBB2.mp4", duration: 10 };
const C = { videoId: "CCCCCCCCCC3", file: "/buf/UC1/CCCCCCCCCC3.mp4", duration: 10 };

const basePlan = (extra: Record<string, unknown> = {}) => ({
  protocol: 1,
  token: "tok-123",
  ffmpegPath: "/opt/homebrew/bin/ffmpeg",
  ffprobePath: "/opt/homebrew/bin/ffprobe",
  ingestUrl: "rtmps://a.rtmps.youtube.com/live2",
  encoder: { codec: "h264_videotoolbox", bitrateKbps: 6000 },
  pass: { number: 1, videos: [A, B], startIndex: 0, startOffset: 0 },
  nextPass: { number: 2, videos: [B, A] },
  playable: [A.videoId, B.videoId],
  toleranceSeconds: 3,
  ...extra,
});

const events = (h: ReturnType<typeof harness>) =>
  (h.appended["events.jsonl"] ?? "")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

test("a complete pass is a pass end: the next run plays the next pass the server drew, from its start", async () => {
  const h = harness({ steps: [{ progress: [5, 20], exit: { code: 0 } }, { progress: [3], exit: { code: 0 } }], files: [A.file, B.file], plan: basePlan(), stopAfterRuns: 2 });
  await h.run();
  const kinds = events(h).map((e) => e.kind);
  assert.deepEqual(kinds.slice(0, 4), ["run_start", "run_exit", "pass_end", "run_start"]);
  assert.equal(events(h)[1].cause, "pass_end");
  assert.match(h.runs[1].list, new RegExp(`file '${B.file}'\\nfile '${A.file}'`), "the next pass's order");
  assert.deepEqual(h.sleeps, [], "no backoff after a pass end");
});

test("an encoder crash restarts after 2 s at the source keyframe before the position, never from the file's start", async () => {
  const h = harness({
    steps: [{ progress: [5, 7.5], exit: { code: 1 } }, { progress: [1], exit: { code: 0 } }],
    files: [A.file, B.file],
    plan: basePlan(),
    keyframe: (_f, offset) => Math.floor(offset / 2) * 2,
    stopAfterRuns: 2,
  });
  await h.run();
  assert.deepEqual(h.sleeps, [2000]);
  const second = events(h).filter((e) => e.kind === "run_start")[1];
  assert.deepEqual([second.videoId, second.inpoint, second.keyframeFound], [A.videoId, 6, true]);
  assert.match(h.runs[1].list, /inpoint 6\.000000/);
  assert.equal(events(h)[1].cause, "encoder_exit");
});

test("consecutive crashes back off 2, 4, 8 s", async () => {
  const crash: Step = { progress: [1], exit: { code: 1 } };
  const h = harness({ steps: [crash, crash, crash, crash], files: [A.file, B.file], plan: basePlan(), stopAfterRuns: 4 });
  await h.run();
  assert.deepEqual(h.sleeps, [2000, 4000, 8000]);
});

test("the next file missing (exit code 0 before the list's end) is source_missing, then the buffer is replayed", async () => {
  // B is not in the buffer: ffmpeg plays A and stops at the join with code 0.
  const h = harness({ steps: [{ progress: [10], exit: { code: 0 } }, { progress: [10], exit: { code: 0 } }], files: [A.file], plan: basePlan(), stopAfterRuns: 2 });
  await h.run();
  const ev = events(h);
  assert.equal(ev[1].cause, "source_missing");
  const replay = ev.find((e) => e.kind === "replay_start");
  assert.deepEqual([replay?.missingVideoId, replay?.videos], [B.videoId, [A.videoId]]);
  assert.ok(h.statuses.some((st) => st.state === "replaying" && st.missingVideoId === B.videoId));
});

test("replaying never includes a video that is no longer playable; with none left it waits for the source", async () => {
  const h = harness({
    steps: [],
    files: [A.file],
    plan: basePlan({ pass: { number: 1, videos: [A, B, C], startIndex: 1, startOffset: 0 }, playable: [B.videoId] }),
    stopAfterSleeps: 1,
  });
  await h.run();
  assert.deepEqual(h.sleeps, [30_000], "it waits 30 s before looking again");
  assert.equal(h.runs.length, 0, "A is in the buffer but no longer playable: it is not streamed");
  assert.ok(events(h).some((e) => e.kind === "waiting_for_source" && e.videoId === B.videoId));
  assert.equal(JSON.parse(h.written["status.json"]).state, "stopped");
});

test("scrubber: the key from ffmpeg's lines and argv reaches no file the helper writes", async () => {
  const h = harness({
    steps: [{ stderr: [`[out#0/flv @ 0x1] Error opening output rtmps://a.rtmps.youtube.com/live2/${KEY}: Connection refused`, `Output #0, flv, to 'rtmps://a.rtmps.youtube.com/live2/${KEY}':`], exit: { code: 1 } }],
    files: [A.file, B.file],
    plan: basePlan(),
    stopAfterRuns: 1,
  });
  await h.run();
  assert.ok(h.runs[0].args.at(-1)?.endsWith(`/${KEY}`), "ffmpeg itself gets the key");
  for (const text of [...Object.values(h.written), ...Object.values(h.appended)]) assert.equal(text.split(KEY).length - 1, 0);
  assert.match(h.appended["helper.log"], /Error opening output rtmps:\/\/a\.rtmps\.youtube\.com\/\[path\]/);
});

test("status carries the adoption token, the pid, the position and the progress", async () => {
  const h = harness({ steps: [{ progress: [12], exit: { code: 1 } }], files: [A.file, B.file], plan: basePlan(), stopAfterRuns: 1 });
  await h.run();
  const status = JSON.parse(h.written["status.json"]);
  assert.deepEqual([status.token, status.pid, status.protocol, status.state], ["tok-123", 4242, 1, "stopped"]);
  assert.deepEqual(status.position, { index: 1, videoId: B.videoId, offset: 2 });
  assert.equal(status.lastExit.cause, "encoder_exit");
});

// With a real ffmpeg and a real helper process against a local RTMP listener (skipped where ffmpeg is missing).
test("real helper process: streams the pass, reports its position, keeps the key out of its files, stops on SIGTERM", async (t) => {
  const { detectFfmpeg, runTool } = await import("@/lib/ffmpeg-host");
  const tools = await detectFfmpeg();
  if (!tools || !tools.features.h264Videotoolbox) return t.skip("ffmpeg with h264_videotoolbox is not installed here");
  const { mkdtemp, readFile, readdir, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawn } = await import("node:child_process");
  const dir = await mkdtemp(path.join(os.tmpdir(), "live-helper-"));
  const port = 19400 + Math.floor(Math.random() * 500);
  const listener = spawn(tools.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-listen", "1", "-i", `rtmp://127.0.0.1:${port}/live/${KEY}`, "-c", "copy", "-f", "null", "-"], { stdio: "ignore" });
  try {
    const clips = [];
    for (const name of ["AAAAAAAAAA1", "BBBBBBBBBB2"]) {
      const file = path.join(dir, `${name}.mp4`);
      await runTool(tools.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", "-c:v", "libx264", "-g", "60", "-c:a", "aac", "-ac", "2", "-shortest", file], { timeoutMs: 60_000 });
      clips.push({ videoId: name, file, duration: 4 });
    }
    await writeFile(
      path.join(dir, "plan.json"),
      JSON.stringify({ ...basePlan(), ffmpegPath: tools.ffmpegPath, ffprobePath: tools.ffprobePath, ingestUrl: `rtmp://127.0.0.1:${port}/live`, pass: { number: 1, videos: clips, startIndex: 0, startOffset: 0 }, nextPass: null, playable: clips.map((c) => c.videoId) })
    );
    await new Promise((r) => setTimeout(r, 500));
    const helper = spawn(process.execPath, [path.join(process.cwd(), "src/lib/live-streams/helper/encoder-helper.mjs"), dir], { stdio: ["pipe", "ignore", "pipe"] });
    helper.stdin.end(`${KEY}\n`);
    await new Promise((r) => setTimeout(r, 6000));
    const running = JSON.parse(await readFile(path.join(dir, "status.json"), "utf8"));
    assert.equal(running.state, "running");
    assert.equal(running.token, "tok-123");
    assert.equal(running.position.videoId, "BBBBBBBBBB2", "about 6 s in: the second clip");
    helper.kill("SIGTERM");
    const code = await new Promise((r) => helper.on("exit", r));
    assert.equal(code, 0);
    assert.equal(JSON.parse(await readFile(path.join(dir, "status.json"), "utf8")).state, "stopped");
    for (const name of await readdir(dir)) {
      if (name.endsWith(".mp4")) continue;
      assert.equal((await readFile(path.join(dir, name), "utf8")).split(KEY).length - 1, 0, name);
    }
  } finally {
    listener.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});

// Independent review, 2026-10-12: the server draws the next pass WHILE a pass plays; the helper must see it at the pass end.
test("the next pass the server draws during the run is the one played next (the plan is read again at the pass end)", async () => {
  const h = harness({
    steps: [{ progress: [20], exit: { code: 0 } }, { progress: [1], exit: { code: 0 } }],
    files: [A.file, B.file, C.file],
    // Before the first run starts there is no next pass; once it is running, the server has drawn [C, B] (A turned private).
    plan: (spawned) => basePlan({ nextPass: spawned === 0 ? null : { number: 2, videos: [C, B] }, playable: [B.videoId, C.videoId] }),
    stopAfterRuns: 2,
  });
  await h.run();
  assert.match(h.runs[1].list, new RegExp(`file '${C.file}'\\nfile '${B.file}'`));
  assert.doesNotMatch(h.runs[1].list, new RegExp(A.file));
});

test("without a drawn next pass, the same order is replayed WITHOUT the videos no longer playable", async () => {
  const h = harness({
    steps: [{ progress: [20], exit: { code: 0 } }, { progress: [1], exit: { code: 0 } }],
    files: [A.file, B.file],
    plan: basePlan({ nextPass: null, playable: [B.videoId] }),
    stopAfterRuns: 2,
  });
  await h.run();
  assert.doesNotMatch(h.runs[1].list, new RegExp(A.file), "A turned private: not in the next pass");
  assert.match(h.runs[1].list, new RegExp(B.file));
});

test("a stop that arrives during the keyframe probe starts no ffmpeg", async () => {
  const h = harness({
    steps: [],
    files: [A.file, B.file],
    plan: basePlan({ pass: { number: 1, videos: [A, B], startIndex: 0, startOffset: 5 } }),
    onProbe: (signal) => {
      signal.stopped = true;
    },
  });
  await h.run();
  assert.equal(h.runs.length, 0);
  assert.equal(h.statuses.at(-1)?.state, "stopped");
});

test("the status is written at once ('starting', with the token and the pass's videos) before any ffmpeg", async () => {
  const h = harness({ steps: [{ progress: [1], exit: { code: 1 } }], files: [A.file, B.file], plan: basePlan(), stopAfterRuns: 1 });
  await h.run();
  assert.deepEqual([h.statuses[0].state, h.statuses[0].token, h.statuses[0].passVideoIds], ["starting", "tok-123", [A.videoId, B.videoId]]);
});

test("waiting for a missing video is recorded once, not every 30 s", async () => {
  const h = harness({ steps: [], files: [], plan: basePlan(), stopAfterSleeps: 3 });
  await h.run();
  assert.equal(events(h).filter((e) => e.kind === "waiting_for_source").length, 1);
  assert.deepEqual(h.sleeps, [30_000, 30_000, 30_000]);
});

test("an ffmpeg with no progress for the stall time is stopped by the helper (a dead connection does not look healthy)", async () => {
  const kills: string[] = [];
  const written: Record<string, string> = {};
  let spawned = 0;
  const signal: { stopped: boolean; onStop?: () => void; wake?: () => void } = { stopped: false };
  const io = {
    readPlan: () => basePlan(),
    exists: () => true,
    writeAtomic: (name: string, text: string) => void (written[name] = text),
    append: () => undefined,
    spawnFfmpeg: () => {
      spawned += 1;
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: (sig: string) => {
          kills.push(sig);
          signal.stopped = true; // end the test after this run
          setImmediate(() => child.emit("exit", null, sig));
          return true;
        },
      });
      return child; // never prints progress, never exits by itself
    },
    probeKeyframe: async () => 0,
    sleep: async () => undefined,
    now: () => Date.now(),
  };
  await runHelper({ dir: "/buf/UC1", key: KEY, pid: 1, stallMs: 50, io: io as never, signal });
  assert.equal(spawned, 1);
  assert.equal(kills[0], "SIGTERM");
});

test("progress blocks with a frozen output time (ffmpeg 7+ prints them on a timer while the connection is dead) do not keep it alive", async () => {
  const kills: string[] = [];
  const signal: { stopped: boolean; onStop?: () => void; wake?: () => void } = { stopped: false };
  let ticker: ReturnType<typeof setInterval> | undefined;
  let clock = 0; // fake time, 10 ms per progress block: a slow or busy test machine cannot change the outcome
  const io = {
    readPlan: () => basePlan(),
    exists: () => true,
    writeAtomic: () => undefined,
    append: () => undefined,
    spawnFfmpeg: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: (sig: string) => {
          kills.push(sig);
          signal.stopped = true;
          clearInterval(ticker);
          setImmediate(() => child.emit("exit", null, sig));
          return true;
        },
      });
      // A progress block every 5 ms, out_time_us stuck at 208980 (what ffmpeg 9 prints writing into a stalled output).
      ticker = setInterval(() => {
        clock += 10;
        child.stdout.write("out_time_us=208980\nbitrate=2200.0kbits/s\nspeed=0.01x\nprogress=continue\n");
      }, 5);
      return child;
    },
    probeKeyframe: async () => 0,
    sleep: async () => undefined,
    now: () => clock,
  };
  await runHelper({ dir: "/buf/UC1", key: KEY, pid: 1, stallMs: 50, io: io as never, signal });
  clearInterval(ticker);
  assert.equal(kills[0], "SIGTERM");
});

test("an ffmpeg whose output time keeps growing is not stopped by the stall watchdog", async () => {
  const kills: string[] = [];
  const signal: { stopped: boolean; onStop?: () => void; wake?: () => void } = { stopped: false };
  let ticker: ReturnType<typeof setInterval> | undefined;
  let clock = 0; // fake time, 10 ms per progress block: a slow or busy test machine cannot change the outcome
  const io = {
    readPlan: () => basePlan(),
    exists: () => true,
    writeAtomic: () => undefined,
    append: () => undefined,
    spawnFfmpeg: () => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: (sig: string) => {
          kills.push(sig);
          return true;
        },
      });
      let outUs = 0;
      ticker = setInterval(() => {
        clock += 10;
        outUs += 5000;
        child.stdout.write(`out_time_us=${outUs}\nprogress=continue\n`);
      }, 5);
      // Runs for 4x the stall time, then ends the way a stop would.
      setTimeout(() => {
        clearInterval(ticker);
        signal.stopped = true;
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", null, "SIGTERM");
      }, 200);
      return child;
    },
    probeKeyframe: async () => 0,
    sleep: async () => undefined,
    now: () => clock,
  };
  await runHelper({ dir: "/buf/UC1", key: KEY, pid: 1, stallMs: 50, io: io as never, signal });
  clearInterval(ticker);
  assert.deepEqual(kills, []);
});
