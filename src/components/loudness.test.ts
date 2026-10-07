import assert from "node:assert/strict";
import test from "node:test";
import { integratedLoudness, matchedVolume } from "./loudness";

// AC-GP3-04 (GENERATION_PLANS_PHASE_3_PLAN.md). Reference values from ITU-R BS.1770-4 / EBU Tech 3341: a stereo 1 kHz sine at
// -23 dBFS per channel reads -23.0 LUFS; doubling the amplitude adds 6.02 LU; silence and too-short audio have no value.

function sine(amplitude: number, seconds: number, fs: number, hz = 1000): Float32Array {
  const out = new Float32Array(Math.round(seconds * fs));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / fs);
  return out;
}

const dbfs = (db: number) => Math.pow(10, db / 20);

test("a stereo 1 kHz sine at -23 dBFS per channel reads -23 LUFS (±0.1) at 48 and 44.1 kHz", () => {
  for (const fs of [48_000, 44_100]) {
    const s = sine(dbfs(-23), 5, fs);
    const l = integratedLoudness([s, s], fs);
    assert.ok(l !== null && Math.abs(l - -23) < 0.1, `${fs}: ${l}`);
  }
});

test("a stereo 1 kHz sine at -20 dBFS reads -20 LUFS (±0.5); twice the amplitude reads 6 LU louder; mono reads 3 LU lower", () => {
  const fs = 48_000;
  const s = sine(dbfs(-20), 5, fs);
  const a = integratedLoudness([s, s], fs)!;
  assert.ok(Math.abs(a - -20) < 0.5, String(a));
  const loud = sine(2 * dbfs(-20), 5, fs);
  assert.ok(Math.abs(integratedLoudness([loud, loud], fs)! - a - 6.02) < 0.05);
  assert.ok(Math.abs(a - integratedLoudness([s], fs)! - 3.01) < 0.05);
});

test("gating: a long silence does not pull the value down; silence and audio under 400 ms give no value", () => {
  const fs = 48_000;
  const tone = sine(dbfs(-23), 5, fs);
  const withSilence = new Float32Array(tone.length * 2);
  withSilence.set(tone, 0);
  const l = integratedLoudness([withSilence, withSilence], fs)!;
  assert.ok(Math.abs(l - -23) < 0.2, String(l));
  assert.equal(integratedLoudness([new Float32Array(fs * 3)], fs), null);
  assert.equal(integratedLoudness([sine(0.5, 0.3, fs)], fs), null);
});

test("matched volume turns loud tracks down to -16 LUFS and never boosts a quiet one", () => {
  assert.ok(Math.abs(matchedVolume(-10) - Math.pow(10, -6 / 20)) < 1e-9);
  assert.equal(matchedVolume(-20), 1);
  assert.equal(matchedVolume(null), 1);
});
