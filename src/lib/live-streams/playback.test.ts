import assert from "node:assert/strict";
import test from "node:test";
import { concatList, encoderArgs, restartDelaySeconds, scrubSecrets } from "./playback.mjs";

// BL-176 acceptance (LIVE_STREAMS_PLAN.md §4.1 "Recovery" and "Scrubber"; §3.6 encoder flags from spike A, §6.1).

test("recovery: consecutive exits wait 2, 4, 8, 16, 32, 60 and 60 s", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 20].map(restartDelaySeconds), [2, 4, 8, 16, 32, 60, 60, 60]);
});

const KEY = "k3y-TEST-0000";

test("scrubber: the fake key appears 0 times in ffmpeg's banner and connection-error lines", () => {
  const lines = [
    `Output #0, flv, to 'rtmps://a.rtmps.youtube.com/live2/${KEY}':`,
    `[out#0/flv @ 0x6000] Error opening output rtmps://a.rtmps.youtube.com/live2/${KEY}: Connection refused`,
    `Error opening output file rtmp://127.0.0.1:19353/live/${KEY}.`,
    `stream key is ${KEY}`,
  ];
  const scrubbed = lines.map((line) => scrubSecrets(line, [KEY]));
  assert.equal(scrubbed.join("\n").split(KEY).length - 1, 0);
  assert.equal(scrubbed[1], "[out#0/flv @ 0x6000] Error opening output rtmps://a.rtmps.youtube.com/[path] Connection refused");
  assert.equal(scrubbed[3], "stream key is [key]");
});

test("scrubber: an ingest path is removed even when the key is not known to the scrubber", () => {
  assert.equal(scrubSecrets("to 'rtmps://a.rtmps.youtube.com/live2/abcd-efgh-ijkl'", []), "to 'rtmps://a.rtmps.youtube.com/[path]'");
});

test("encoder flags: 2 s keyframes (60 frames at 30 fps), no B-frames, sound copied, FLV out; CBR padding only with libx264", () => {
  const vt = encoderArgs({ listPath: "/b/run.ffconcat", codec: "h264_videotoolbox", bitrateKbps: 6000, outputUrl: "rtmps://x/live2/K" });
  const x264 = encoderArgs({ listPath: "/b/run.ffconcat", codec: "libx264", bitrateKbps: 6000, outputUrl: "rtmps://x/live2/K" });
  for (const args of [vt, x264]) {
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(at("-g"), "60");
    assert.equal(at("-bf"), "0");
    assert.equal(at("-c:a"), "copy");
    assert.equal(at("-vf"), "fps=30");
    assert.equal(at("-b:v"), "6000k");
    assert.equal(args[args.lastIndexOf("-f") + 1], "flv", "the last -f is the output format");
    assert.equal(at("-f"), "concat", "the first -f is the input list");
    assert.equal(args.at(-1), "rtmps://x/live2/K");
    assert.ok(args.includes("-re"));
    assert.ok(!args.includes("-report"), "never a report file (it would hold the URL)");
  }
  assert.equal(x264[x264.indexOf("-x264-params") + 1], "nal-hrd=cbr:force-cfr=1");
  assert.equal(vt[vt.indexOf("-c:v") + 1], "h264_videotoolbox");
});

test("concat list: quoted paths, the inpoint only on the first file", () => {
  assert.equal(concatList(["/b/A.mp4", "/b/it's.mp4"], 3000), "ffconcat version 1.0\nfile '/b/A.mp4'\ninpoint 3000.000000\nfile '/b/it'\\''s.mp4'\n");
  assert.equal(concatList(["/b/A.mp4"], 0), "ffconcat version 1.0\nfile '/b/A.mp4'\n");
});
