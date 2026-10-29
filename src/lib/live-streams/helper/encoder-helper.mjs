// ---------------------------------------------------------------------------
// BL-176 (docs/roadmap/plans/LIVE_STREAMS_PLAN.md §3.6/§3.7, ADR 0036 §4) -- the encoder helper: a small standalone node
// process, started detached by the server so it survives server restarts (spike A, §6.1). It runs ffmpeg over the
// stream's buffer files and restarts it when it exits. It never writes to YouTube and never stores the key.
//
// Contract, all files in the stream's folder `<appData>/live-streams/<channelId>/`:
//   plan.json    server -> helper: ffmpeg path, ingest address (no key), encoder, the pass, the next pass, the playable
//                videos, an adoption token. Re-read at every run start.
//   status.json  helper -> server: state, position, progress, restarts, last exit; carries the token (the server adopts
//                a running helper only when pid AND token match). Scrubbed.
//   events.jsonl helper -> server: one JSON line per run start/exit, pass end, replay. Scrubbed. The server imports them.
//   helper.log   ffmpeg's warnings and the helper's own lines, scrubbed.
// The key arrives on stdin (one line) and lives only in this process and in ffmpeg's argv.
//
// Usage: node encoder-helper.mjs <streamDir>
// ---------------------------------------------------------------------------
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { keyframeProbeArgs, pickKeyframeAtOrBefore } from "../../ffmpeg-host/keyframes.mjs";
import {
  BACKOFF_RESET_AFTER_SECONDS,
  classifyRunEnd,
  concatList,
  encoderArgs,
  locatePlayback,
  passLength,
  restartDelaySeconds,
  scrubSecrets,
} from "../playback.mjs";

export const HELPER_PROTOCOL = 1;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const WAIT_FOR_SOURCE_MS = 30_000;
const KILL_GRACE_MS = 5_000;
/** The status is rewritten at least this often, ffmpeg or not: the server tells a live helper from a hung one by it. */
export const HEARTBEAT_MS = 10_000;
/** ffmpeg with no progress for this long is stuck (e.g. on a dead connection): it is stopped, and the run restarts. */
export const STALL_MS = 60_000;

/** The ffmpeg this process runs now: killed if the helper itself dies, so no encoder outlives it (independent review). */
let activeChild = null;

/**
 * @typedef {{ videoId: string; file: string; duration: number }} PlanVideo
 * @typedef {{ number: number; videos: PlanVideo[]; startIndex?: number; startOffset?: number }} PlanPass
 * @typedef {{ protocol: number; token: string; ffmpegPath: string; ffprobePath: string; ingestUrl: string;
 *   encoder: { codec: "h264_videotoolbox" | "libx264"; bitrateKbps: number }; pass: PlanPass; nextPass: PlanPass | null;
 *   playable: string[]; toleranceSeconds?: number }} HelperPlan
 */

/** Default I/O, replaced in tests. */
function realIo(dir) {
  return {
    readPlan: () => /** @type {HelperPlan} */ (JSON.parse(readFileSync(path.join(dir, "plan.json"), "utf8"))),
    exists: (file) => existsSync(file),
    writeAtomic(name, text) {
      const target = path.join(dir, name);
      writeFileSync(`${target}.tmp`, text);
      renameSync(`${target}.tmp`, target);
    },
    append(name, text) {
      const target = path.join(dir, name);
      try {
        if (name === "helper.log" && statSync(target).size > LOG_ROTATE_BYTES) renameSync(target, `${target}.1`);
      } catch {
        // no log yet
      }
      appendFileSync(target, text);
    },
    spawnFfmpeg: (ffmpegPath, args) => spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] }),
    probeKeyframe: (ffprobePath, file, offset) =>
      new Promise((resolve) => {
        if (offset <= 0) return resolve(0);
        execFile(ffprobePath, keyframeProbeArgs(file, offset, 30), { timeout: 60_000 }, (error, stdout) => resolve(error ? null : pickKeyframeAtOrBefore(stdout, offset)));
      }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/**
 * Runs the stream until `signal.stopped` turns true. Exported for tests (fake ffmpeg, fake files).
 * @param {{ dir: string; key: string; pid?: number; heartbeatMs?: number; stallMs?: number; io?: Partial<ReturnType<typeof realIo>>; signal?: { stopped: boolean; onStop?: () => void; wake?: () => void } }} options
 */
export async function runHelper(options) {
  const io = { ...realIo(options.dir), ...options.io };
  const signal = options.signal ?? { stopped: false };
  /** A wait that a stop cuts short (SIGTERM must not sit out a 60 s backoff). */
  const sleep = (ms) =>
    new Promise((resolve) => {
      signal.wake = resolve;
      io.sleep(ms).then(resolve);
    });
  const secrets = [options.key];
  const scrub = (text) => scrubSecrets(text, secrets);
  const log = (line) => io.append("helper.log", `${new Date(io.now()).toISOString()} ${scrub(line)}\n`);
  const event = (kind, detail) => {
    try {
      io.append("events.jsonl", `${scrub(JSON.stringify({ at: io.now(), kind, ...detail }))}\n`);
    } catch {
      // a full disk or a removed folder must not kill the stream
    }
  };

  let plan = io.readPlan();
  const token = plan.token;
  let pass = plan.pass;
  let position = { index: pass.startIndex ?? 0, offset: pass.startOffset ?? 0 };
  let failures = 0;
  let restarts = 0;
  let runs = 0;
  let lastExit = null;
  /** @type {Record<string, unknown>} */
  let progress = {};
  let lastState = { state: "starting", extra: {} };

  // The status names the pass's videos too, so the server keeps its record of the pass in step with what is played.
  const writeStatus = (state, extra = {}) => {
    lastState = { state, extra };
    try {
      io.writeAtomic(
        "status.json",
        scrub(
          JSON.stringify({
            protocol: HELPER_PROTOCOL,
            token,
            pid: options.pid ?? process.pid,
            state,
            passNumber: pass.number,
            passVideoIds: pass.videos.map((v) => v.videoId),
            position: { index: position.index, videoId: pass.videos[position.index]?.videoId ?? null, offset: position.offset },
            runs,
            restarts,
            lastExit,
            progress,
            updatedAt: io.now(),
            ...extra,
          })
        )
      );
    } catch {
      // a full disk or a removed folder must not kill the stream; the heartbeat tries again
    }
  };
  // At once, before any wait: from this moment the server sees this helper (no second one is started beside it).
  writeStatus("starting");
  const heartbeat = setInterval(() => writeStatus(lastState.state, lastState.extra), options.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref?.();

  /** One ffmpeg run over `files` starting at `inpoint`; resolves with what happened. */
  async function runOnce(files, inpoint, onProgress) {
    // A stop that arrived while the run was being prepared (e.g. during the keyframe probe) starts nothing.
    if (signal.stopped) return { code: null, signal: "SIGTERM", outTime: 0 };
    const listPath = path.join(options.dir, "run.ffconcat");
    io.writeAtomic("run.ffconcat", concatList(files, inpoint));
    const args = encoderArgs({ listPath, codec: plan.encoder.codec, bitrateKbps: plan.encoder.bitrateKbps, outputUrl: `${plan.ingestUrl}/${options.key}` });
    const child = io.spawnFfmpeg(plan.ffmpegPath, args);
    activeChild = child;
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref?.();
    };
    signal.onStop = stop;
    if (signal.stopped) stop();
    // The heartbeat keeps the status fresh, so a stuck ffmpeg would otherwise look healthy forever (verification review).
    // Progress means the output time growing: ffmpeg 7+ prints its progress block on a timer even when nothing is sent
    // (a dead connection), with out_time_us frozen (final check, ffmpeg 9.0.2).
    let lastProgressAt = io.now();
    let lastGrownOutTime = -1;
    const watchdog = setInterval(() => {
      if (io.now() - lastProgressAt > (options.stallMs ?? STALL_MS)) {
        log(`no progress from ffmpeg for ${Math.round((io.now() - lastProgressAt) / 1000)}s: stopping it`);
        lastProgressAt = io.now();
        stop();
      }
    }, Math.min(10_000, options.stallMs ?? STALL_MS));
    watchdog.unref?.();
    let outTime = 0;
    // BL-233: when this ffmpeg run began, so a reader can tell how far the output lags the clock (-re sends in real time).
    const runStartedAt = io.now();
    /** @type {Record<string, string>} */
    let block = {};
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        onLine(line);
      } catch {
        // never let a status write kill the helper and orphan ffmpeg
      }
    });
    const onLine = (line) => {
      const eq = line.indexOf("=");
      if (eq < 0) return;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      block[k] = v;
      if (k === "out_time_us" && /^\d+$/.test(v)) outTime = Number(v) / 1e6;
      if (k === "progress") {
        progress = {
          outTime,
          bitrate: block.bitrate ?? null,
          totalSize: block.total_size ? Number(block.total_size) : null,
          dropFrames: block.drop_frames ? Number(block.drop_frames) : null,
          dupFrames: block.dup_frames ? Number(block.dup_frames) : null,
          speed: block.speed ?? null,
          runStartedAt,
          // BL-233 review: when this block arrived -- the heartbeat rewrites the status later with the same progress.
          at: io.now(),
        };
        block = {};
        if (outTime > lastGrownOutTime) {
          lastGrownOutTime = outTime;
          lastProgressAt = io.now();
        }
        onProgress(outTime);
      }
    };
    createInterface({ input: child.stderr }).on("line", (line) => {
      try {
        log(`ffmpeg: ${line}`);
      } catch {
        // as above
      }
    });
    const exit = await new Promise((resolve) => {
      child.on("exit", (code, sig) => resolve({ code, signal: sig }));
      child.on("error", (error) => resolve({ code: null, signal: null, error: String(error?.message ?? error) }));
    });
    clearInterval(watchdog);
    signal.onStop = undefined;
    activeChild = null;
    return { ...exit, outTime };
  }

  /** The video last reported as awaited (undefined = not waiting). */
  let waitingFor;
  while (!signal.stopped) {
    plan = io.readPlan();
    if (plan.pass.number === pass.number) pass = plan.pass;
    const tolerance = plan.toleranceSeconds ?? 3;
    const current = pass.videos[position.index];

    // The next file is not in the buffer (the T9 is gone, a copy failed): replay what is there and still playable.
    if (!current || !io.exists(current.file)) {
      const replay = pass.videos.filter((v) => plan.playable.includes(v.videoId) && io.exists(v.file));
      if (replay.length === 0) {
        writeStatus("waiting_for_source", { missingVideoId: current?.videoId ?? null });
        // Once per missing video, not every 30 s (the history would show nothing else).
        if (waitingFor !== (current?.videoId ?? null)) event("waiting_for_source", { videoId: current?.videoId ?? null });
        waitingFor = current?.videoId ?? null;
        await sleep(WAIT_FOR_SOURCE_MS);
        continue;
      }
      waitingFor = undefined;
      runs += 1;
      event("replay_start", { missingVideoId: current?.videoId ?? null, videos: replay.map((v) => v.videoId) });
      writeStatus("replaying", { missingVideoId: current?.videoId ?? null });
      const started = io.now();
      const result = await runOnce(replay.map((v) => v.file), 0, () => writeStatus("replaying", { missingVideoId: current?.videoId ?? null }));
      const ran = (io.now() - started) / 1000;
      lastExit = { at: io.now(), code: result.code, signal: result.signal, cause: "replay_end", ranSeconds: ran };
      event("replay_end", { code: result.code, signal: result.signal, ranSeconds: ran });
      if (signal.stopped) break;
      if (ran < BACKOFF_RESET_AFTER_SECONDS && classifyRunEnd({ outTimeSeconds: result.outTime, expectedSeconds: replay.reduce((s, v) => s + v.duration, 0), toleranceSeconds: tolerance }) === "early_end") {
        const wait = restartDelaySeconds(failures);
        failures += 1;
        restarts += 1;
        writeStatus("restarting", { waitSeconds: wait });
        await sleep(wait * 1000);
      } else {
        failures = 0;
      }
      continue;
    }

    // A normal run: the rest of the pass, from the source keyframe at or before the position (§3.6).
    waitingFor = undefined;
    const keyframe = await io.probeKeyframe(plan.ffprobePath, current.file, position.offset);
    const inpoint = keyframe ?? position.offset;
    const durations = pass.videos.map((v) => v.duration);
    const startIndex = position.index;
    const expected = passLength(durations, startIndex, inpoint);
    runs += 1;
    event("run_start", { passNumber: pass.number, index: startIndex, videoId: current.videoId, inpoint, keyframeFound: keyframe !== null });
    const started = io.now();
    const result = await runOnce(pass.videos.slice(startIndex).map((v) => v.file), inpoint, (outTime) => {
      const at = locatePlayback(durations, { startIndex, startOffset: inpoint }, outTime);
      if (!at.passEnded) position = { index: at.index, offset: at.offset };
      writeStatus("running");
    });
    const ran = (io.now() - started) / 1000;
    const end = classifyRunEnd({ outTimeSeconds: result.outTime, expectedSeconds: expected, toleranceSeconds: tolerance });
    const at = locatePlayback(durations, { startIndex, startOffset: inpoint }, result.outTime);
    const cause = end === "pass_end" ? "pass_end" : result.code === 0 ? "source_missing" : "encoder_exit";
    lastExit = { at: io.now(), code: result.code, signal: result.signal, cause, ranSeconds: ran, ...(result.error ? { error: result.error } : {}) };
    event("run_exit", { passNumber: pass.number, index: at.index, offset: at.offset, code: result.code, signal: result.signal, cause, ranSeconds: ran });
    if (signal.stopped) break;

    if (end === "pass_end") {
      // The server draws the next pass while this one plays (it may have changed the rotation): read the plan again now.
      try {
        plan = io.readPlan();
      } catch {
        // keep the last plan read
      }
      const next =
        plan.nextPass && plan.nextPass.number === pass.number + 1
          ? plan.nextPass
          : { number: pass.number + 1, videos: pass.videos.filter((v) => plan.playable.includes(v.videoId)) };
      event("pass_end", { passNumber: pass.number, nextPassNumber: next.number });
      pass = next;
      position = { index: 0, offset: 0 };
      failures = 0;
      continue;
    }

    position = at.passEnded ? { index: pass.videos.length - 1, offset: 0 } : { index: at.index, offset: at.offset };
    if (ran >= BACKOFF_RESET_AFTER_SECONDS) failures = 0;
    const wait = restartDelaySeconds(failures);
    failures += 1;
    restarts += 1;
    writeStatus("restarting", { waitSeconds: wait });
    log(`run ${runs} ended early (${cause}); restarting in ${wait}s at video ${position.index} +${position.offset}s`);
    await sleep(wait * 1000);
  }

  clearInterval(heartbeat);
  writeStatus("stopped");
  event("stopped", {});
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    process.stderr.write("usage: encoder-helper.mjs <streamDir>\n");
    process.exit(2);
  }
  const key = await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    let done = false;
    rl.once("line", (line) => {
      done = true;
      rl.close();
      resolve(line.trim());
    });
    rl.once("close", () => {
      if (!done) resolve("");
    });
  });
  if (!key) {
    process.stderr.write("no stream key on stdin\n");
    process.exit(2);
  }
  const signal = { stopped: false, onStop: undefined, wake: undefined };
  const stop = () => {
    signal.stopped = true;
    signal.onStop?.();
    signal.wake?.();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // Whatever ends this process, its ffmpeg goes with it.
  process.on("exit", () => activeChild?.kill("SIGKILL"));
  process.on("uncaughtException", (error) => {
    process.stderr.write(`helper failed: ${error?.message ?? error}\n`);
    activeChild?.kill("SIGKILL");
    process.exit(1);
  });
  await runHelper({ dir, key, signal });
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`helper failed: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
