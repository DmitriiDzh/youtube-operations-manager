import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedReleaseVideo } from "@/lib/local-video-cleanup/allowlist";
import { isNamedAfterRelease, videoNumberOfFolder } from "@/lib/workspace-videos";
import { compareVideoCodes, compareVideoCodesDesc, isLegacyVCode, isReadableVideoCode, isVideoCode, parseVideoCode, reportVersionFor } from "./index";

// BL-263 (docs/roadmap/plans/SHORT_VIDEO_CODE_PLAN.md §3, §7, §10; ADR 0071 §1). Expected values from the plan, written by hand:
// - a code is `^(V|S)[1-9][0-9]{0,5}$` for every input (AC-SC-01);
// - file readers keep their current lenient V (`V\d+`) and add a strict S (§3, AC-SC-04);
// - highest first: the V block, then S, each numerically (AC-SC-11);
// - a report is version 2 only when it holds an S code (§5, AC-SC-10).

test("AC-SC-01: S1, S14, S999999, V1, V49 are codes; S0, S01, S1000000, X5, s14, SV1 and the empty string are not", () => {
  for (const code of ["S1", "S14", "S999999", "V1", "V49"]) assert.equal(isVideoCode(code), true, code);
  for (const bad of ["S0", "S01", "S1000000", "X5", "s14", "SV1", "", "V0", "V07", "V1000000", " S14", "S14 "]) assert.equal(isVideoCode(bad), false, JSON.stringify(bad));
});

test("§3 / AC-SC-04: a file reader still reads a legacy V07 or V0; an S is strict there too (S014 is not read)", () => {
  assert.equal(isLegacyVCode("V07"), true);
  assert.equal(isReadableVideoCode("V07"), true);
  assert.equal(isReadableVideoCode("V0"), true);
  assert.equal(isReadableVideoCode("S14"), true);
  assert.equal(isReadableVideoCode("S014"), false);
  assert.equal(isReadableVideoCode("S0"), false);
  assert.deepEqual(parseVideoCode("S14"), { series: "S", number: 14 });
  assert.deepEqual(parseVideoCode("V49"), { series: "V", number: 49 });
  assert.equal(parseVideoCode("X5"), null);
});

test("AC-SC-11: [S10, V2, S2, V10] highest first is V10, V2, S10, S2; ascending V2, V10, S2, S10", () => {
  assert.deepEqual(["S10", "V2", "S2", "V10"].sort(compareVideoCodesDesc), ["V10", "V2", "S10", "S2"]);
  assert.deepEqual(["S10", "V2", "S2", "V10"].sort(compareVideoCodes), ["V2", "V10", "S2", "S10"]);
});

test("§5: a report is version 1 while it holds no S code, version 2 as soon as one row names an S", () => {
  assert.equal(reportVersionFor([]), 1);
  assert.equal(reportVersionFor(["V1", "V49", null]), 1);
  assert.equal(reportVersionFor(["V1", "S14"]), 2);
  assert.equal(reportVersionFor([null, "S1"]), 2);
});

test("AC-SC-02 (folder rule): `1120 S14 Short` is S14's folder; `1120 S014`, `1120 S0` are no release folder; V stays as before", () => {
  assert.equal(videoNumberOfFolder("1120 S14 Short"), "S14");
  assert.equal(videoNumberOfFolder("1120 S14"), "S14");
  assert.equal(videoNumberOfFolder("1120 S014 Short"), null);
  assert.equal(videoNumberOfFolder("1120 S0"), null);
  assert.equal(videoNumberOfFolder("1120 S14Short"), null);
  assert.equal(videoNumberOfFolder("0928 V39"), "V39");
  assert.equal(videoNumberOfFolder("0928 V07 Short"), "V07", "a legacy V07 folder read today is still read");
  assert.equal(videoNumberOfFolder("0928 X39"), null);
});

test("AC-SC-05: `S14 WWE.mp4` is named after S14, not after S1; `V14 WWE.mp4` is not named after S14", () => {
  assert.equal(isNamedAfterRelease("S14 WWE.mp4", "S14"), true);
  assert.equal(isNamedAfterRelease("S14 WWE.mp4", "S1"), false);
  assert.equal(isNamedAfterRelease("V14 WWE.mp4", "S14"), false);
  assert.equal(isNamedAfterRelease("S14_release.json", "S14"), true);
});

test("AC-SC-02 (cleanup allowlist): an S release's own mp4 in a `MMDD Sn Short` folder may be deleted; a mismatched code may not", () => {
  assert.equal(isAllowedReleaseVideo("04 Videos/11 November/1120 S14 Short/S14 WWE.mp4", "S14", "WWE"), true);
  assert.equal(isAllowedReleaseVideo("04 Videos/11 November/1120 S14 Short/S14 WWE.mp4", "S1", "WWE"), false);
  assert.equal(isAllowedReleaseVideo("04 Videos/11 November/1120 S15 Short/S14 WWE.mp4", "S14", "WWE"), false);
  assert.equal(isAllowedReleaseVideo("04 Videos/11 November/1120 S014 Short/S014 WWE.mp4", "S014", "WWE"), false);
  assert.equal(isAllowedReleaseVideo("04 Videos/11 November/1120 V14 Short/V14 WWE.mp4", "V14", "WWE"), true, "V unchanged");
});
