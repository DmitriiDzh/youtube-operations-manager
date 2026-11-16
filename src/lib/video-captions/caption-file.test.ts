import assert from "node:assert/strict";
import test from "node:test";
import { captionFormatOfName, captionNameProblem, checkCaptionFile, isEnglishLanguage } from "./caption-file";
import { sha256Hex } from "./hash";

// BL-269 AC-CAP-08 / AC-CAP-09 (VIDEO_CAPTIONS_PLAN.md §3.1): hand-written fixtures. SubRip: an optional index line, then
// `HH:MM:SS,mmm --> HH:MM:SS,mmm`; WebVTT: a `WEBVTT` header (after an optional BOM), `.` milliseconds, optional hours.

const enc = (text: string) => new TextEncoder().encode(text);
const SRT = "1\r\n00:00:01,000 --> 00:00:03,500\r\nHello\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nWorld\r\n";
const VTT = "\uFEFFWEBVTT\n\nNOTE written by hand\n\n00:01.000 --> 00:03.500 align:start\nHello\n\ncue-2\n00:04.000 --> 00:06.000\nWorld\n";

test("AC-CAP-09 valid SRT (CRLF) and VTT (BOM, no hours, a NOTE, a cue id, cue settings) pass", () => {
  assert.deepEqual(checkCaptionFile(enc(SRT), "V27_captions.en.srt", 10), { ok: true, format: "srt", cues: 2, lastEndMs: 6000 });
  assert.deepEqual(checkCaptionFile(enc(VTT), "V27_captions.en.vtt", 10), { ok: true, format: "vtt", cues: 2, lastEndMs: 6000 });
  // Hours in VTT, and an SRT without index lines.
  assert.equal(checkCaptionFile(enc("WEBVTT\n\n01:00:00.000 --> 01:00:02.000\nx\n"), "a.vtt", 3700).ok, true);
  assert.equal(checkCaptionFile(enc("00:00:01,000 --> 00:00:02,000\nx\n"), "a.srt", null).ok, true);
});

test("AC-CAP-09 refused: .srt holding VTT, .vtt without the header, non-UTF-8, end <= start, 61 seconds, after the video", () => {
  const detail = (bytes: Uint8Array, name: string, duration: number | null) => {
    const r = checkCaptionFile(bytes, name, duration);
    assert.equal(r.ok, false);
    return r.ok ? "" : r.detail;
  };
  assert.match(detail(enc(VTT), "a.srt", 10), /holds WebVTT/);
  assert.match(detail(enc(SRT), "a.vtt", 10), /WEBVTT/);
  assert.match(detail(new Uint8Array([0x31, 0x0a, 0xff, 0xfe, 0x0a]), "a.srt", 10), /UTF-8/);
  assert.match(detail(enc("00:00:03,000 --> 00:00:03,000\nx\n"), "a.srt", 10), /ends before/);
  assert.match(detail(enc("00:00:05,000 --> 00:00:04,000\nx\n"), "a.srt", 10), /ends before/);
  assert.match(detail(enc("00:00:01,000 --> 00:00:61,000\nx\n"), "a.srt", 100), /bad timestamp/);
  // Duration 10 s: a cue ending at 11.000 is within the 1 s tolerance, one ending at 12.000 (2 s after) is not.
  assert.equal(checkCaptionFile(enc("00:00:01,000 --> 00:00:11,000\nx\n"), "a.srt", 10).ok, true);
  assert.match(detail(enc("00:00:01,000 --> 00:00:12,000\nx\n"), "a.srt", 10), /after the video/);
  assert.match(detail(enc("WEBVTT\n\nNOTE only a note\n"), "a.vtt", 10), /no cue/);
  assert.match(detail(enc("1\nHello\n"), "a.srt", 10), /no timing line/);
  assert.match(detail(enc("00:00:01.000 --> 00:00:02.000\nx\n"), "a.srt", 10), /bad timestamp/);
  assert.match(detail(enc("WEBVTT\n\n00:01,000 --> 00:02,000\nx\n"), "a.vtt", 10), /bad timestamp/);
  assert.match(detail(enc(SRT), "a.txt", 10), /not a .srt or .vtt/);
});

test("AC-CAP-08 the name: empty and 150 characters accepted; 151 characters or < > refused", () => {
  assert.equal(captionNameProblem(""), null);
  assert.equal(captionNameProblem("x".repeat(150)), null);
  assert.match(captionNameProblem("x".repeat(151)) ?? "", /150/);
  assert.match(captionNameProblem("English <auto>") ?? "", /< or >/);
});

test("helpers: format by extension, English by primary subtag, SHA-256 hex", () => {
  assert.equal(captionFormatOfName("V1_captions.en.VTT"), "vtt");
  assert.equal(captionFormatOfName("V1.srt.txt"), null);
  assert.equal(isEnglishLanguage("en"), true);
  assert.equal(isEnglishLanguage("en-GB"), true);
  assert.equal(isEnglishLanguage("eng"), false);
  assert.equal(isEnglishLanguage("de"), false);
  assert.equal(isEnglishLanguage(null), false);
  // SHA-256 of "abc" (FIPS 180-2 test vector).
  assert.equal(sha256Hex(enc("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("review #7 WebVTT: only cue settings (vertical/line/position/size/align/region as key:value) may follow the end time", () => {
  const vtt = (timing: string) => checkCaptionFile(enc(`﻿WEBVTT\n\n${timing}\nHello\n`), "V27_captions.en.vtt", 10);
  // The WebVTT cue settings (W3C WebVTT §4.4): accepted, alone or together, separated by spaces or tabs.
  for (const settings of ["", " align:start", " align:middle line:90% position:50%,center size:80%", "\tvertical:rl\tline:-1", " region:fred align:end"]) {
    assert.equal(vtt(`00:01.000 --> 00:03.000${settings}`).ok, true, settings);
  }
  // Anything else after the end time: refused.
  for (const tail of [" Hello there", " align:", " :start", " align:start junk", " color:red", " align:start -->"]) {
    const r = vtt(`00:01.000 --> 00:03.000${tail}`);
    assert.equal(r.ok, false, tail);
    assert.match(r.ok ? "" : r.detail, /cue setting/);
  }
  // The factory's files: an empty-name track's .vtt with a BOM and no settings stays valid.
  assert.equal(checkCaptionFile(enc("﻿WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx\n"), "V30_captions.en.vtt", 5).ok, true);
});
