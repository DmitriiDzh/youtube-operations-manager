import { createPackageReviewsOwnerCore, OWNER_REVIEW_PROBLEM_CODES, wellFormedReplies, type PackageReviewsOwnerSurface, type ReviewPackage, type ReviewPackagesResult } from "@/lib/package-reviews";
import { createPackageScanCore, type PackageScanResult, type ScannedPackage } from "@/lib/publishing";
import { createVideoProjectsServiceForProduction } from "@/lib/video-projects";
import { invalidatePlanPackages } from "@/lib/publishing-plan-progress";
import { nudgeReviewNotify } from "@/lib/review-notify";

// BL-257 (ADR 0070, AGENTS.md §M): the package-reviews owner surface composed at the app layer -- its packages and files come from the
// publishing module's scan, its decisions drop the weekly plan's package cache (AC-PR-10) and nudge the Producer's Inbox writer
// (AC-PR-13). package-reviews itself imports neither module. Used only by the Web UI's package-review routes (AC-PR-08).

/** The scan's packages as the review screen needs them: every package with a parsed manifest and a manifest hash. Pure. */
export function reviewPackagesOf(scan: PackageScanResult): ReviewPackagesResult {
  if (scan.status !== "ok") return { status: scan.status };
  const packages: ReviewPackage[] = [];
  for (const p of scan.packages as ScannedPackage[]) {
    if (!p.pkg || !p.manifestSha256) continue;
    packages.push({
      manifestSha256: p.manifestSha256,
      manifestPath: p.manifestPath,
      video: p.pkg.video,
      title: p.pkg.title,
      description: p.pkg.description,
      languages: Object.keys(p.pkg.localizations ?? {}).sort(),
      slotId: p.pkg.slotId ?? null,
      plannedPublishDate: p.pkg.plannedPublishDate,
      durationSeconds: p.durationSeconds ?? p.pkg.durationSeconds,
      videoPath: `${p.folder}/${p.pkg.files.video}`,
      thumbnailPath: p.thumbnailPath,
      videoSha256: p.pkg.sha256 ?? null,
      videoSizeBytes: p.pkg.sizeBytes,
      uploaded: p.youtube !== null,
      videoId: p.youtube?.videoId ?? null,
      // Owner TG 4846 (AC-IS-03): the factory's answers to the owner's issues, read by package-reviews' lenient rule.
      ...(p.pkg.reviewReplies !== undefined ? { reviewReplies: wellFormedReplies(p.pkg.reviewReplies) } : {}),
      otherProblems: p.problems.map((problem) => problem.code).filter((code) => !OWNER_REVIEW_PROBLEM_CODES.includes(code)),
    });
  }
  return { status: "ok", packages };
}

// The player sends many Range requests: the media routes reuse a channel's scan for a short while (the file itself is resolved and
// checked again on every request).
const MEDIA_SCAN_MS = 30_000;
const MEMO_KEY = Symbol.for("ytom.packageReviews.mediaScanMemo");
type GlobalWithMemo = typeof globalThis & { [MEMO_KEY]?: Map<string, { at: number; result: ReviewPackagesResult }> };

/**
 * Owner TG 4584 (BL-263 fix): what the owner path's `afterChange` does once a recode carried his decision to a new manifest -- the
 * media routes' short-lived scan dropped, the Producer's Inbox writer nudged (the weekly plan's cache is dropped by the recode itself).
 * Used by `src/composition/release-recode.ts` only.
 */
export function afterReviewCarried(channelId: string): void {
  (globalThis as GlobalWithMemo)[MEMO_KEY]?.delete(channelId);
  nudgeReviewNotify();
}

export function packageReviewsForRoutes(): PackageReviewsOwnerSurface {
  const memo = ((globalThis as GlobalWithMemo)[MEMO_KEY] ??= new Map());
  const scanCore = createPackageScanCore();
  return createPackageReviewsOwnerCore({
    async packages(channelId, options) {
      const hit = memo.get(channelId);
      if (options?.cached && hit && Date.now() - hit.at < MEDIA_SCAN_MS) return hit.result;
      const result = reviewPackagesOf(await scanCore.scan(channelId));
      memo.set(channelId, { at: Date.now(), result });
      return result;
    },
    resolveFile: (channelId, relativePath) => scanCore.resolvePackageFile(channelId, relativePath),
    // BL-265 (ADR 0072 §1): a media decision follows the BL-263 recode alias (V -> S) the video list knows.
    recodeAliases: (channelId) => createVideoProjectsServiceForProduction().recodeAliasesOf(channelId),
    afterChange(channelId) {
      memo.delete(channelId);
      invalidatePlanPackages(channelId);
      nudgeReviewNotify();
    },
  });
}
