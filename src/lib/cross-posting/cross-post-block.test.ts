import assert from "node:assert/strict";
import test from "node:test";
import { parseCrossPostBlock, videoProblems } from "./cross-post-block";

// BL-252 stage 2 (ADR 0068 amendment 1). Expected values from Meta's published rules (limits.ts sources): Instagram Reel caption
// ≤2200 characters, ≤30 hashtags, ≤20 @mentions, 3 s–15 min, ≤300 MB; Facebook Page Reel 3–90 s, title ≤255; both 9:16.

test("no block = no targets, no problems; a non-object block and an unknown network are problems", () => {
  assert.deepEqual(parseCrossPostBlock(undefined), { targets: [], problems: [] });
  assert.deepEqual(parseCrossPostBlock(null), { targets: [], problems: [] });
  assert.deepEqual(parseCrossPostBlock("x").problems, [{ network: null, code: "block_invalid" }]);
  assert.deepEqual(parseCrossPostBlock({ tiktok: { caption: "a" } }).problems, [{ network: null, code: "network_unknown", params: { network: "tiktok" } }]);
});

test("a valid block: Instagram shares to feed unless false; Facebook title optional; `at` HH:MM", () => {
  const out = parseCrossPostBlock({ instagram: { caption: "Hello #space", at: "18:30" }, facebook: { description: "Hi", title: "T" } });
  assert.deepEqual(out.problems, []);
  assert.deepEqual(out.targets, [
    { network: "instagram", caption: "Hello #space", shareToFeed: true, at: "18:30" },
    { network: "facebook", title: "T", description: "Hi", at: null },
  ]);
  assert.equal((parseCrossPostBlock({ instagram: { caption: "x", shareToFeed: false } }).targets[0] as { shareToFeed: boolean }).shareToFeed, false);
});

test("limits: 2201 characters, 31 hashtags, 21 mentions, a 256-character title, an empty caption, a bad time", () => {
  const codes = (raw: unknown) => parseCrossPostBlock(raw).problems.map((p) => `${p.network}:${p.code}`);
  assert.deepEqual(codes({ instagram: { caption: "a".repeat(2200) } }), []);
  assert.deepEqual(codes({ instagram: { caption: "a".repeat(2201) } }), ["instagram:caption_too_long"]);
  const tags = (n: number) => Array.from({ length: n }, (_, i) => `#t${i}`).join(" ");
  assert.deepEqual(codes({ instagram: { caption: tags(30) } }), []);
  assert.deepEqual(codes({ instagram: { caption: tags(31) } }), ["instagram:too_many_hashtags"]);
  const mentions = (n: number) => Array.from({ length: n }, (_, i) => `@u${i}`).join(" ");
  assert.deepEqual(codes({ instagram: { caption: mentions(21) } }), ["instagram:too_many_mentions"]);
  assert.deepEqual(codes({ facebook: { description: "d", title: "t".repeat(256) } }), ["facebook:title_too_long"]);
  assert.deepEqual(codes({ instagram: { caption: "  " } }), ["instagram:caption_required"]);
  assert.deepEqual(codes({ facebook: {} }), ["facebook:description_required"]);
  assert.deepEqual(codes({ facebook: { description: "d", at: "25:00" } }), ["facebook:at_invalid"]);
});

test("video: Facebook refuses 91 s while Instagram takes it; 2.9 s refused by both; landscape refused; unreadable is not a pass", () => {
  const both = parseCrossPostBlock({ instagram: { caption: "c" }, facebook: { description: "d" } }).targets;
  const v = (durationSeconds: number | null, width: number | null = 1080, height: number | null = 1920, sizeBytes: number | null = 50e6) => ({ durationSeconds, sizeBytes, width, height });
  const codes = (video: ReturnType<typeof v>) => videoProblems(both, video).map((p) => `${p.network}:${p.code}`);
  assert.deepEqual(codes(v(60)), []);
  assert.deepEqual(codes(v(90)), []);
  assert.deepEqual(codes(v(91)), ["facebook:duration_out_of_range"]);
  assert.deepEqual(codes(v(2.9)), ["instagram:duration_out_of_range", "facebook:duration_out_of_range"]);
  assert.deepEqual(codes(v(30, 1920, 1080)), ["instagram:not_vertical", "facebook:not_vertical"]);
  assert.deepEqual(codes(v(30, 1080, 1920, 301 * 1024 * 1024)), ["instagram:file_too_large"]);
  assert.deepEqual(codes(v(null)), ["instagram:video_unreadable", "facebook:video_unreadable"]);
});
