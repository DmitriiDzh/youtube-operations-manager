import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectFfmpeg, keyframeAtOrBefore, parseFeatures, parseProbe, pickKeyframeAtOrBefore, probeMedia, runTool } from "./index";

// Output shapes are ffmpeg 9's own (`ffmpeg -protocols`, `ffmpeg -encoders`, `ffprobe -of json`), copied from the Mac's
// Homebrew ffmpeg-full 9.0.2 on 2026-10-12.

const PROTOCOLS = `Supported file protocols:
Input:
  file
  rtmp
  rtmps
Output:
  file
  rtmp
  rtmps
`;
const ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
`;

test("parseFeatures: rtmps as an OUTPUT protocol, and the two H.264 encoders", () => {
  assert.deepEqual(parseFeatures(PROTOCOLS, ENCODERS), { rtmps: true, h264Videotoolbox: true, libx264: true });
});

test("parseFeatures: rtmps only as an input protocol does not count; missing encoders are false", () => {
  const inputOnly = "Supported file protocols:\nInput:\n  rtmps\nOutput:\n  file\n";
  assert.deepEqual(parseFeatures(inputOnly, " ------\n A....D aac   AAC\n"), { rtmps: false, h264Videotoolbox: false, libx264: false });
});

test("parseProbe: duration, size, the first video and audio stream, stream counts", () => {
  const json = JSON.stringify({
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30/1" },
      { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 },
    ],
    format: { duration: "7382.344375", size: "920220699" },
  });
  assert.deepEqual(parseProbe(json), {
    durationSeconds: 7382.344375,
    sizeBytes: 920220699,
    video: { codec: "h264", width: 1920, height: 1080, frameRate: 30 },
    audio: { codec: "aac", sampleRate: 48000, channels: 2 },
    audioStreams: 1,
    videoStreams: 1,
  });
});

test("parseProbe: no audio stream and an N/A duration", () => {
  const probe = parseProbe(JSON.stringify({ streams: [{ codec_type: "video", codec_name: "h264", r_frame_rate: "30000/1001" }], format: { duration: "N/A" } }));
  assert.equal(probe.audio, null);
  assert.equal(probe.durationSeconds, null);
  assert.equal(probe.video?.frameRate, 29.97);
});

test("pickKeyframeAtOrBefore: the last keyframe not after the offset", () => {
  assert.equal(pickKeyframeAtOrBefore("2991.666667\n3000.000000\n3008.333333\n", 3005), 3000);
  assert.equal(pickKeyframeAtOrBefore("3000.000000\n", 3000), 3000);
  assert.equal(pickKeyframeAtOrBefore("3008.333333\n", 3005), null);
  assert.equal(pickKeyframeAtOrBefore("", 3005), null);
});

test("detectFfmpeg: the configured folder is tried first; a folder without ffprobe is skipped; none found is null", async () => {
  const present = new Set(["/opt/homebrew/bin/ffmpeg", "/opt/homebrew/bin/ffprobe", "/custom/ffmpeg"]);
  const calls: string[] = [];
  const run = async (file: string, args: readonly string[]) => {
    calls.push(file);
    if (args.includes("-version")) return "ffmpeg version 9.0.2 Copyright";
    return args.includes("-protocols") ? PROTOCOLS : ENCODERS;
  };
  // The platform is fixed: the Mac's paths are the same whichever computer runs this test.
  const tools = await detectFfmpeg({ configuredDir: "/custom", pathEnv: "", platform: "darwin", run, exists: async (f) => present.has(f) });
  assert.deepEqual(tools, {
    ffmpegPath: "/opt/homebrew/bin/ffmpeg",
    ffprobePath: "/opt/homebrew/bin/ffprobe",
    version: "9.0.2",
    features: { rtmps: true, h264Videotoolbox: true, libx264: true },
  });
  assert.ok(!calls.includes("/custom/ffmpeg"), "a folder with ffmpeg but no ffprobe is not used");
  assert.equal(await detectFfmpeg({ pathEnv: "", platform: "darwin", run, exists: async () => false }), null);
});

test("detectFfmpeg on Windows: finds ffmpeg.exe and ffprobe.exe in PATH (also a quoted entry); names without .exe are not used", async () => {
  // ffmpeg installed by winget: its bin folder is in PATH, the programs are `.exe` files.
  const present = new Set([
    "C:\\plain\\ffmpeg",
    "C:\\plain\\ffprobe",
    "C:\\only-ffmpeg\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe",
  ]);
  const checked: string[] = [];
  const run = async (_file: string, args: readonly string[]) => {
    if (args.includes("-version")) return "ffmpeg version 9.0.1-full_build-www.gyan.dev Copyright";
    return args.includes("-protocols") ? PROTOCOLS : ENCODERS;
  };
  const exists = async (f: string) => {
    checked.push(f);
    return present.has(f);
  };
  const tools = await detectFfmpeg({
    pathEnv: 'C:\\plain;C:\\only-ffmpeg;"C:\\Program Files\\ffmpeg\\bin";',
    platform: "win32",
    run,
    exists,
  });
  assert.deepEqual(tools, {
    ffmpegPath: "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
    ffprobePath: "C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe",
    version: "9.0.1-full_build-www.gyan.dev",
    features: { rtmps: true, h264Videotoolbox: true, libx264: true },
  });
  assert.ok(!checked.some((f) => f.includes("homebrew")), "the Mac's install folders are not looked at on Windows");
  assert.equal(await detectFfmpeg({ pathEnv: "C:\\plain", platform: "win32", run, exists }), null);
});

// With a real ffmpeg on this computer (skipped where there is none, e.g. a Windows machine without it).
test("real ffmpeg: probe a generated clip and find the keyframe at or before an offset", async (t) => {
  const tools = await detectFfmpeg();
  if (!tools) return t.skip("ffmpeg is not installed here");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ffmpeg-host-"));
  try {
    const clip = path.join(dir, "clip.mp4");
    await runTool(
      tools.ffmpegPath,
      ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "10", "-c:v", "libx264", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-c:a", "aac", "-ac", "2", "-shortest", clip],
      { timeoutMs: 60_000 }
    );
    const probe = await probeMedia(tools, clip);
    assert.ok(probe.durationSeconds !== null && Math.abs(probe.durationSeconds - 10) < 0.2, String(probe.durationSeconds));
    assert.deepEqual(probe.audio, { codec: "aac", sampleRate: 48000, channels: 2 });
    // A keyframe every 60 frames at 30 fps = every 2 s: 0, 2, 4, 6, 8.
    assert.equal(await keyframeAtOrBefore(tools, clip, 5), 4);
    assert.equal(await keyframeAtOrBefore(tools, clip, 6), 6);
    assert.equal(await keyframeAtOrBefore(tools, clip, 0), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
