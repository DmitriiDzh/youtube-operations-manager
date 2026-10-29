import assert from "node:assert/strict";
import test from "node:test";
import { encoderReading, parseEncoderBitrateKbps, parseEncoderSpeed } from "./encoder-load";
import type { HelperStatus } from "./supervisor";

// BL-233 (FO-REQ-0047 ask 3): the encoder's speed, bitrate and lag from the helper's status. ffmpeg's -progress fields (ffmpeg
// docs): `speed=0.973x` (or `N/A`), `bitrate=3980.2kbits/s` (or `N/A`), `out_time_us`. The encoder reads with -re (real time), so
// the output lags the clock by (time since the run began - output time). Expected numbers by hand.

const NOW = 10_000_000;

function status(over: Partial<HelperStatus> & { progress?: Record<string, unknown> } = {}): HelperStatus {
  return { protocol: 1, token: "t", pid: 1, state: "running", passNumber: 1, position: { index: 0, videoId: null, offset: 0 }, lastExit: null, progress: {}, updatedAt: NOW - 2_000, ...over };
}

test("speed and bitrate parse ffmpeg's own text; N/A and nonsense are null", () => {
  assert.equal(parseEncoderSpeed("0.973x"), 0.973);
  assert.equal(parseEncoderSpeed(" 1x"), 1);
  assert.equal(parseEncoderSpeed(0.5), 0.5);
  for (const bad of ["N/A", "", "fast", "-1x", null, undefined, Number.NaN, -0.2]) assert.equal(parseEncoderSpeed(bad), null, String(bad));
  assert.equal(parseEncoderBitrateKbps("3980.2kbits/s"), 3980.2);
  for (const bad of ["N/A", "4000", 4000, null]) assert.equal(parseEncoderBitrateKbps(bad), null, String(bad));
});

test("a running stream: speed, bitrate, target and the lag from the run's start time", () => {
  // Run began 3,600 s before the status; 3,560 s of output sent -> 40 s behind.
  const reading = encoderReading(
    { channelId: "UCc", intentOn: true, targetBitrateKbps: 4000, status: status({ progress: { outTime: 3560, speed: "0.989x", bitrate: "3990.4kbits/s", runStartedAt: NOW - 2_000 - 3_600_000 } }) },
    NOW
  );
  assert.deepEqual(
    [reading.running, reading.speed, reading.bitrateKbps, reading.targetBitrateKbps, reading.lagSeconds, reading.lagEstimated, reading.outTimeSeconds],
    [true, 0.989, 3990.4, 4000, 40, false, 3560]
  );
});

test("a helper from before BL-233 (no run start): the lag is estimated from ffmpeg's speed and says so", () => {
  // 0.676x after 3,380 s of output: the run took 3,380 / 0.676 = 5,000 s, so 1,620 s behind.
  const reading = encoderReading({ channelId: "UCc", intentOn: true, targetBitrateKbps: 6000, status: status({ progress: { outTime: 3380, speed: "0.676x" } }) }, NOW);
  assert.deepEqual([reading.lagSeconds, reading.lagEstimated], [1620, true]);
});

test("no status, a stale one (over 60 s), or a stopped helper: not running, no numbers", () => {
  for (const s of [null, status({ updatedAt: NOW - 61_000, progress: { outTime: 5, speed: "1x" } }), status({ state: "stopped", progress: { outTime: 5, speed: "1x" } })]) {
    const reading = encoderReading({ channelId: "UCc", intentOn: true, targetBitrateKbps: null, status: s }, NOW);
    assert.deepEqual([reading.running, reading.speed, reading.lagSeconds, reading.outTimeSeconds], [false, null, null, null]);
  }
});

test("restarting or waiting for a video: fresh but not sending; replaying the buffer still sends", () => {
  assert.equal(encoderReading({ channelId: "U", intentOn: true, targetBitrateKbps: null, status: status({ state: "restarting" }) }, NOW).running, false);
  assert.equal(encoderReading({ channelId: "U", intentOn: true, targetBitrateKbps: null, status: status({ state: "waiting_for_source" }) }, NOW).helperState, "waiting_for_source");
  assert.equal(encoderReading({ channelId: "U", intentOn: true, targetBitrateKbps: null, status: status({ state: "replaying", progress: { outTime: 1, speed: "1x" } }) }, NOW).running, true);
});

test("a damaged progress (strings, missing fields) gives nulls, never a throw", () => {
  const reading = encoderReading({ channelId: "U", intentOn: false, targetBitrateKbps: Number.NaN, status: status({ progress: { outTime: "12", speed: 3, bitrate: 7, runStartedAt: "x" } }) }, NOW);
  assert.deepEqual([reading.outTimeSeconds, reading.speed, reading.bitrateKbps, reading.lagSeconds, reading.targetBitrateKbps], [null, 3, null, null, null]);
});
