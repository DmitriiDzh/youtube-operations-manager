import assert from "node:assert/strict";
import test from "node:test";
import type { ScannedPackage } from "@/lib/publishing";
import { reviewPackagesOf } from "./package-reviews";

// BL-257 (ADR 0070 §6): the review screen's packages from the publishing scan -- every package with a parsed manifest and a manifest
// hash; the video's path from the manifest's own file name; the package's other problems without the review's own codes; uploaded
// when an upload record names a video. A scan that cannot run says why.

const base = (over: Partial<ScannedPackage>): ScannedPackage => ({
  manifestPath: "04 Videos/11 November/1115 V11/V11_release.json",
  folder: "04 Videos/11 November/1115 V11",
  video: "V11",
  title: "T",
  plannedPublishDate: "2026-11-20",
  thumbnailPath: "04 Videos/11 November/1115 V11/Thumb.jpg",
  sizeBytes: 10,
  durationSeconds: 58,
  state: "not_ready",
  problems: [{ code: "owner_review_pending" }],
  youtube: null,
  existsOnChannel: null,
  checkedAt: null,
  pkg: {
    channelId: "UC_wwe",
    video: "V11",
    mix: null,
    plannedPublishDate: "2026-11-20",
    files: { video: "V11 Final.mp4", thumbnail: "Thumb.jpg" },
    sizeBytes: 10,
    durationSeconds: 58,
    title: "Why the bell rings",
    description: "D",
    tags: [],
    defaultLanguage: "en",
    defaultAudioLanguage: "en",
    ready: true,
    problems: [],
    sha256: "f".repeat(64),
    slotId: "slot-1",
    localizations: { es: { title: "t", description: "d" }, de: { title: "t", description: "d" } },
  },
  manifestSha256: "a".repeat(64),
  ...over,
});

test("BL-257: the scan's packages as the review screen needs them", () => {
  const result = reviewPackagesOf({
    status: "ok",
    packages: [
      base({}),
      base({ manifestSha256: "b".repeat(64), problems: [{ code: "thumbnail_missing" }, { code: "owner_review_returned", params: { comment: "x" } }] }),
      base({ manifestSha256: "c".repeat(64), state: "uploaded_private", problems: [], youtube: { videoId: "vid", privacyStatus: "private", publishAt: null } }),
      base({ manifestSha256: null }),
      base({ pkg: null, manifestSha256: "d".repeat(64), problems: [{ code: "invalid_json" }] }),
    ],
  });
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.packages[0], {
    manifestSha256: "a".repeat(64),
    manifestPath: "04 Videos/11 November/1115 V11/V11_release.json",
    video: "V11",
    title: "Why the bell rings",
    description: "D",
    languages: ["de", "es"],
    slotId: "slot-1",
    plannedPublishDate: "2026-11-20",
    durationSeconds: 58,
    videoPath: "04 Videos/11 November/1115 V11/V11 Final.mp4",
    thumbnailPath: "04 Videos/11 November/1115 V11/Thumb.jpg",
    videoSha256: "f".repeat(64),
    // BL-265 (ADR 0072 §1): the media key's size (the manifest's sizeBytes) and the uploaded video's id.
    videoSizeBytes: 10,
    uploaded: false,
    videoId: null,
    otherProblems: [],
  });
  assert.deepEqual(result.packages.map((p) => [p.manifestSha256[0], p.uploaded, p.otherProblems]), [["a", false, []], ["b", false, ["thumbnail_missing"]], ["c", true, []]]);
  assert.deepEqual(reviewPackagesOf({ status: "no_workspace" }), { status: "no_workspace" });
  assert.deepEqual(reviewPackagesOf({ status: "workspace_unavailable", reason: "x" }), { status: "workspace_unavailable" });
});
