import assert from "node:assert/strict";
import test from "node:test";
import { canPlay, popupSources } from "./video-popup";

// BL-260 (owner msg 4421): the popup player's sources. Expected by hand: the package's own file through the package-review video
// route (by manifest SHA-256, URL-encoded channel), YouTube's privacy-enhanced player and the watch link by video id.

const SHA = "a".repeat(64);

test("BL-260: a package plays its own file; a YouTube video has the embed and the watch link; nothing -> nothing to play", () => {
  assert.deepEqual(popupSources("UC a/b", { manifestSha256: SHA, videoId: "abc_DEF-123" }), {
    local: `/api/channels/UC%20a%2Fb/package-reviews/video?manifest=${SHA}`,
    embed: "https://www.youtube-nocookie.com/embed/abc_DEF-123?autoplay=1&rel=0",
    watch: "https://www.youtube.com/watch?v=abc_DEF-123",
  });
  assert.deepEqual(popupSources("UC1", { manifestSha256: SHA }), { local: `/api/channels/UC1/package-reviews/video?manifest=${SHA}`, embed: null, watch: null });
  assert.deepEqual(popupSources("UC1", { videoId: "v1" }).local, null);
  assert.equal(canPlay({ manifestSha256: null, videoId: null }), false);
  assert.equal(canPlay({ manifestSha256: SHA }), true);
  assert.equal(canPlay({ videoId: "v1" }), true);
});
