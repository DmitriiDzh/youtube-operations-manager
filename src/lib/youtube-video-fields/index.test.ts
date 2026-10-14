import assert from "node:assert/strict";
import test from "node:test";
import { imageKindOf, tagsLength, THUMBNAIL_MAX_BYTES } from "./index";

// YouTube Data API videos resource: snippet.tags "maximum length of 500 characters" -- commas between tags count, and a tag with
// a space is quoted (both quotes count). thumbnails.set: JPEG or PNG, at most 2 MB. Expected values by hand.

test("tagsLength counts each tag, the commas between them and the quotes of a tag with a space", () => {
  assert.equal(tagsLength([]), 0);
  assert.equal(tagsLength(["jazz"]), 4);
  assert.equal(tagsLength(["jazz", "lofi"]), 9);
  assert.equal(tagsLength(["lofi radio"]), 12);
  assert.equal(tagsLength(["джаз", "lo fi"]), 4 + 1 + 7);
});

test("imageKindOf reads the first bytes, not a name; THUMBNAIL_MAX_BYTES is 2 MiB", () => {
  assert.equal(imageKindOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(imageKindOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
  assert.equal(imageKindOf(new Uint8Array([0x47, 0x49, 0x46, 0x38])), "other");
  assert.equal(imageKindOf(new Uint8Array([0xff, 0xd8])), "other");
  assert.equal(THUMBNAIL_MAX_BYTES, 2_097_152);
});
