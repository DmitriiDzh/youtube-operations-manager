import assert from "node:assert/strict";
import test from "node:test";
import { audioFileOf, pcmFormatOfMime, pcmToWav, wavInfo } from "./index";

// BL-236: the RIFF/WAVE layout (Microsoft's WAVE format: "RIFF" size "WAVE", a 16-byte "fmt " chunk with PCM = 1, channels, rate,
// byte rate = rate x channels x bits/8, block align, bits; then "data" size and the samples). Expected values by hand.

test("pcmFormatOfMime reads Gemini's raw PCM mime (rate from the parameter, default otherwise); a container is not PCM", () => {
  assert.deepEqual(pcmFormatOfMime("audio/L16;codec=pcm;rate=24000", 16000), { sampleRateHz: 24000, channels: 1, bitsPerSample: 16 });
  assert.deepEqual(pcmFormatOfMime("audio/pcm", 24000), { sampleRateHz: 24000, channels: 1, bitsPerSample: 16 });
  assert.equal(pcmFormatOfMime("audio/wav", 24000), null);
  assert.equal(pcmFormatOfMime("audio/mpeg", 24000), null);
});

test("pcmToWav writes the 44-byte header: 1 s of 24 kHz mono 16-bit is 48,000 data bytes, byte rate 48,000, block align 2", () => {
  const wav = pcmToWav(Buffer.alloc(48_000), { sampleRateHz: 24_000, channels: 1, bitsPerSample: 16 });
  assert.equal(wav.length, 44 + 48_000);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + 48_000);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt32LE(28), 48_000);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt32LE(40), 48_000);
  assert.deepEqual(wavInfo(wav), { sampleRateHz: 24_000, channels: 1, bitsPerSample: 16, dataBytes: 48_000, durationSeconds: 1 });
});

test("audioFileOf: PCM becomes a .wav at its own rate (no resampling); a WAV is kept; mp3 keeps its extension and no length", () => {
  const fromPcm = audioFileOf({ mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.alloc(96_000) }, 24_000);
  assert.equal(fromPcm.extension, "wav");
  assert.equal(fromPcm.sampleRateHz, 24_000);
  assert.equal(fromPcm.durationSeconds, 2);
  const wav = pcmToWav(Buffer.alloc(88_200), { sampleRateHz: 44_100, channels: 1, bitsPerSample: 16 });
  const kept = audioFileOf({ mimeType: "audio/wav", data: wav }, 24_000);
  assert.equal(kept.data, wav);
  assert.equal(kept.sampleRateHz, 44_100);
  assert.equal(kept.durationSeconds, 1);
  const mp3 = audioFileOf({ mimeType: "audio/mpeg", data: Buffer.from("ID3") }, 24_000);
  assert.deepEqual([mp3.extension, mp3.mimeType, mp3.sampleRateHz, mp3.durationSeconds], ["mp3", "audio/mpeg", null, null]);
});

test("wavInfo refuses bytes that are not a RIFF/WAVE file", () => {
  assert.equal(wavInfo(Buffer.from("not a wav file at all")), null);
});

test("review item 4: an odd PCM byte count is cut to whole frames -- 48,001 bytes of 24 kHz mono is 48,000 data bytes, exactly 1 s", () => {
  const file = audioFileOf({ mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.alloc(48_001, 1) }, 24_000);
  assert.equal(file.data.length, 44 + 48_000);
  assert.equal(file.data.readUInt32LE(40), 48_000);
  assert.equal(file.data.readUInt32LE(4), 36 + 48_000);
  assert.equal(file.durationSeconds, 1);
  // Stereo: 4-byte frames; 10 bytes keep 8.
  assert.equal(pcmToWav(Buffer.alloc(10), { sampleRateHz: 24_000, channels: 2, bitsPerSample: 16 }).readUInt32LE(40), 8);
});
