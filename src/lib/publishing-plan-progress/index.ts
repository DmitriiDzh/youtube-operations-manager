import { createPackageScanCore, createPublishingSettingsCore, listChannelUploads, ownerReviewStateFor, packageScanFilesSignature, packageScanSignature, removedVideosOf } from "@/lib/publishing";
import { decisionsOfVideo, issueCounts, issuesOf, issuesReadout, standingDecision, timedCommentsReadout, wellFormedReplies } from "@/lib/package-reviews";
import type { PlanProgressResult, PlanSlotProgress, PublishingPlansPorts } from "@/lib/publishing-plans";
import { createPackagesReader, invalidatePackagesEntry, type PackagesEntry } from "./packages-cache";
import { deletedVideosBySlot, progressOfSlots, progressWithUploads, type MediaReviewOf } from "./progress";

/**
 * BL-267 (plan §3.4, AC-WT-41): the owner's media review of a channel's packages by package-reviews' own rule (`standingDecision`),
 * for every package, uploaded ones included -- `not_required` when the channel has no gate; `unreadable` when the review state cannot
 * be read (counts as not approved: fail closed).
 */
export async function mediaReviewReaderOf(channelId: string, read: (channelId: string) => ReturnType<typeof ownerReviewStateFor> = ownerReviewStateFor): Promise<MediaReviewOf> {
  try {
    const state = await read(channelId);
    // Owner TG 4817 (AC-TC-08): the standing decision's timed comments, also on a channel without the gate (he may still decide).
    const timedComments: MediaReviewOf["timedComments"] = (key) => timedCommentsReadout(standingDecision(state, key)?.timedComments ?? []);
    const reader: MediaReviewOf = state.required
      ? (key) => {
          const standing = standingDecision(state, key);
          return standing?.kind === "approved" ? "approved" : standing?.kind === "returned" ? "returned" : "pending";
        }
      : () => "not_required";
    reader.timedComments = timedComments;
    // Owner TG 4846 (AC-IS-07): the video's issues across its package versions, with this package's answers (read leniently).
    reader.issues = (video, rawReplies, manifestSha256) => {
      const issues = issuesOf(decisionsOfVideo(state.decisions, video, state.aliases), wellFormedReplies(rawReplies), manifestSha256);
      return { issues: issuesReadout(issues), counts: issueCounts(issues) };
    };
    // Owner TG 4836: the notes of a standing approval (an approval with a comment), for the plan's package.
    reader.approvalComment = (key) => {
      const standing = standingDecision(state, key);
      return standing?.kind === "approved" && (standing.comment ?? "").trim() !== "" ? standing.comment : null;
    };
    return reader;
  } catch {
    return () => "unreadable";
  }
}

// BL-225 stage 2 (ADR 0051, AGENTS.md §M): the plan's `progress` port from the publishing module's package scan, given to the plan's
// surfaces by the MCP deps and the Web routes. A scan reads the channel's whole `04 Videos/` folder, so one is kept for a minute per
// channel (the plan screen polls every minute; agents read on demand). A failed scan gives no progress -- never a wrong one.

const CACHE_KEY = Symbol.for("ytom.publishingPlanProgress.cache");
type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: Map<string, PackagesEntry> };

const packagesCache = ((globalThis as GlobalWithCache)[CACHE_KEY] ??= new Map());

/** BL-257 (AC-PR-10): drop the channel's kept package scan (an owner package-review decision or switch changed it). */
export function invalidatePlanPackages(channelId: string): void {
  invalidatePackagesEntry(packagesCache, channelId);
}

const packagesOf = createPackagesReader({
  removedVideos: (channelId) => removedVideosOf(channelId),
  scan: (channelId, removedVideos) => createPackageScanCore().scan(channelId, { removedVideos }),
  synthetic: async (channelId) => (await createPublishingSettingsCore().read(channelId)).settings.containsSyntheticMedia,
  // BL-270: a kept scan is reused for up to 5 minutes while the folder and the copy are unchanged (the plan schedule reads every minute).
  signature: (channelId) => packageScanSignature(channelId),
  // BL-270 review (finding 3): and only while the files the kept scan resolved are unchanged (a re-render below the walk's depth).
  filesSignature: (channelId, packages) => packageScanFilesSignature(channelId, packages),
  now: () => Date.now(),
  cache: packagesCache,
});

/** BL-263: S code → the V codes recoded to it (the video list's recode alias); a list that cannot be read: none. */
async function recodedBySCode(channelId: string): Promise<Map<string, string[]>> {
  try {
    const { createVideoProjectsServiceForProduction } = await import("@/lib/video-projects");
    const out = new Map<string, string[]>();
    // A light read of the reservations (no workspace walk): this port runs on every plan poll.
    for (const [v, s] of await createVideoProjectsServiceForProduction().recodeAliasesOf(channelId)) out.set(s, [...(out.get(s) ?? []), v]);
    return out;
  } catch {
    return new Map();
  }
}

/** The plan's progress port: the packages (`built`, `packaged`) and this computer's uploads (`uploading`, `failed`, `scheduled`, `published`). */
export const publishingPlanProgress: NonNullable<PublishingPlansPorts["progress"]> = async (channelId, _weekStart, slotIds): Promise<PlanProgressResult> => {
  const found = await packagesOf(channelId);
  // BL-225 stage 3: this computer's upload rows name their slot -- uploading, failed (with the step's code), scheduled, published.
  const rows = await listChannelUploads(channelId).catch(() => []);
  // BL-243: of two deleted packages naming a slot, the one uploaded last speaks (`uploadTimeOf`: record, else the row's own time).
  const reviewOf = found.packages ? await mediaReviewReaderOf(channelId) : undefined;
  const fromPackages = found.packages ? progressOfSlots(found.packages, slotIds, found.synthetic, rows, reviewOf) : new Map<string, PlanSlotProgress>();
  // BL-243: the rows of removed videos and deleted packages say nothing -- by the same removed list the packages were scanned with.
  const progress = progressWithUploads(fromPackages, rows, slotIds, Date.now(), {
    removedVideoIds: found.removedVideoIds,
    deletedVideosBySlot: found.packages ? deletedVideosBySlot(found.packages, rows) : new Map(),
  });
  // BL-263 (plan §6.5): the V codes recoded to each slot's S package, so the owner's approval of the uploaded V still counts.
  const recoded = await recodedBySCode(channelId);
  if (recoded.size > 0) {
    for (const [slotId, slot] of progress) {
      const from = slot.package ? recoded.get(slot.package.video) : undefined;
      if (from) progress.set(slotId, { ...slot, recodedFrom: from });
    }
  }
  // The packages could not be read: save()'s approval rule then keeps the older, stricter one.
  return { progress, packagesUnavailable: found.packages === null };
};

export { deletedVideosBySlot, progressOfPackage, progressOfSlots, progressOfUploadRow, progressWithUploads } from "./progress";
