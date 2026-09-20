// ---------------------------------------------------------------------------
// Acceptance matrix (AGENTS.md §L), fixed from the official YouTube Data API v3 reference
// (checked live 2026-09-20) and the owner's own requirement before writing services.ts:
//
// AC-SCHEMA-01: description's 5000-byte limit is UTF-8 BYTES, not JS string length -- a
//   multi-byte string must be measured with Buffer.byteLength, not .length.
// AC-SCHEMA-02: tags' 500-character budget counts comma separators and quote-wrapping of any
//   tag containing a space, not the raw joined length.
// AC-SCHEMA-03: publishAt is rejected unless the same patch also sets privacyStatus: "private".
// AC-SCHEMA-04: an empty patch (no fields at all) is rejected.
// AC-SCHEMA-05: an unknown/unlisted field in the patch is rejected (.strict()) -- this module
//   must never silently accept, and therefore silently ignore, a field a caller thought it set.
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import test from "node:test";
import { previewFieldsUpdateInputSchema } from "./schemas";

function baseInput(patch: Record<string, unknown>) {
  return {
    credentialRef: { userId: "u1" },
    expectedChannelId: "UC_TEST",
    videoId: "v1",
    patch,
  };
}

test("AC-SCHEMA-01: description at exactly 5000 bytes (multi-byte) is accepted, one byte over is rejected", () => {
  // Each "€" is 3 UTF-8 bytes -- 1666 of them is 4998 bytes, plus 2 ASCII chars = 5000 exactly.
  const exactly5000Bytes = "€".repeat(1666) + "ab";
  assert.equal(Buffer.byteLength(exactly5000Bytes, "utf8"), 5000);
  const okResult = previewFieldsUpdateInputSchema.safeParse(baseInput({ description: exactly5000Bytes }));
  assert.equal(okResult.success, true);

  const oneByteOver = "€".repeat(1666) + "abc";
  assert.equal(Buffer.byteLength(oneByteOver, "utf8"), 5001);
  const failResult = previewFieldsUpdateInputSchema.safeParse(baseInput({ description: oneByteOver }));
  assert.equal(failResult.success, false);
});

test("AC-SCHEMA-01: a description well under 5000 JS characters can still exceed the byte budget", () => {
  // A description made entirely of 3-byte characters hits the byte cap at ~1667 characters,
  // long before the naive (character-count) 5000 limit -- proves .length alone would wrongly
  // accept this.
  const multiByteHeavy = "€".repeat(1700);
  assert.ok(multiByteHeavy.length < 5000);
  assert.ok(Buffer.byteLength(multiByteHeavy, "utf8") > 5000);
  const result = previewFieldsUpdateInputSchema.safeParse(baseInput({ description: multiByteHeavy }));
  assert.equal(result.success, false);
});

test("AC-SCHEMA-02: tags budget accounts for comma separators and space-quoting, not raw joined length", () => {
  // Ten 48-char tags with spaces: each becomes `"..."` (50 chars) when assembled, joined by
  // 9 commas -- 500 + 9 = 509 > 500, so this must be rejected even though naively summing
  // each tag's own .length (480) would look fine.
  const tagsWithSpaces = Array.from({ length: 10 }, (_, i) => `tag number ${i} padded to len`.padEnd(48, "x"));
  const naiveSum = tagsWithSpaces.reduce((sum, t) => sum + t.length, 0);
  assert.ok(naiveSum <= 500, "test fixture sanity: naive sum must look fine to prove the real check catches it");

  const result = previewFieldsUpdateInputSchema.safeParse(baseInput({ tags: tagsWithSpaces }));
  assert.equal(result.success, false);
});

test("AC-SCHEMA-02: tags without spaces fit exactly at the 500-char budget", () => {
  // 9 tags of 50 chars + 9 commas between 10 tags... use a value we can compute cleanly:
  // 10 tags of 49 chars each + 9 commas = 490 + 9 = 499 <= 500.
  const tags = Array.from({ length: 10 }, (_, i) => `tag${i}`.padEnd(49, "x"));
  const result = previewFieldsUpdateInputSchema.safeParse(baseInput({ tags }));
  assert.equal(result.success, true);
});

test("AC-SCHEMA-03: publishAt is rejected without privacyStatus: private in the same patch", () => {
  const withoutPrivacy = previewFieldsUpdateInputSchema.safeParse(
    baseInput({ publishAt: "2026-12-01T00:00:00Z" })
  );
  assert.equal(withoutPrivacy.success, false);

  const withWrongPrivacy = previewFieldsUpdateInputSchema.safeParse(
    baseInput({ publishAt: "2026-12-01T00:00:00Z", privacyStatus: "public" })
  );
  assert.equal(withWrongPrivacy.success, false);

  const withPrivate = previewFieldsUpdateInputSchema.safeParse(
    baseInput({ publishAt: "2026-12-01T00:00:00Z", privacyStatus: "private" })
  );
  assert.equal(withPrivate.success, true);
});

test("AC-SCHEMA-04: an empty patch is rejected", () => {
  const result = previewFieldsUpdateInputSchema.safeParse(baseInput({}));
  assert.equal(result.success, false);
});

test("AC-SCHEMA-05: an unknown field in the patch is rejected, not silently dropped", () => {
  const result = previewFieldsUpdateInputSchema.safeParse(
    baseInput({ title: "ok", thumbnailUrl: "https://example.com/x.jpg" })
  );
  assert.equal(result.success, false);
});

test("title over 100 characters is rejected", () => {
  const result = previewFieldsUpdateInputSchema.safeParse(baseInput({ title: "x".repeat(101) }));
  assert.equal(result.success, false);
});

test("an invalid privacyStatus enum value is rejected", () => {
  const result = previewFieldsUpdateInputSchema.safeParse(baseInput({ privacyStatus: "hidden" }));
  assert.equal(result.success, false);
});
