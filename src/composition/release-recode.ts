import { readOwnerReviewState } from "@/lib/package-reviews";
import { createReleaseRecodeCore, type ReleaseRecodeInput, type ReleaseRecodeResult } from "@/lib/publishing";
import { invalidatePlanPackages } from "@/lib/publishing-plan-progress";
import { createStoryboardsCoreForProduction, createVideoCostsShareCoreForProduction, createVideoReservationsShareCoreForProduction } from "@/lib/sync-gateway";
import { createVideoProjectsServiceForProduction } from "@/lib/video-projects";
import { planSlotDecisions } from "./publishing-plan-slots";

// BL-263 (SHORT_VIDEO_CODE_PLAN.md §6, ADR 0071 §4): the recode as the factory tool reaches it -- only this one operation of the
// publishing module (no upload, no YouTube writer), with what other modules own handed in here (AGENTS.md §M): the channel's video list
// (video-projects), the owner's package-review approvals and the weekly plan's slot decisions, the storyboards linked to the video, the
// other computers' own rows naming it, and the reservations / costs reports written again afterwards.
export async function recodeRelease(input: ReleaseRecodeInput): Promise<ReleaseRecodeResult> {
  const videos = createVideoProjectsServiceForProduction();
  const storyboards = createStoryboardsCoreForProduction();
  return createReleaseRecodeCore({
    videoList: async (channelId) => {
      const list = await videos.listVideos({ channelId });
      if (list.workspace !== "ok") throw new Error(`the channel workspace is ${list.workspace}`);
      return list;
    },
    approvals: async (channelId) => {
      const [review, slots] = await Promise.all([readOwnerReviewState(channelId), planSlotDecisions(channelId)]);
      return { reviewApproved: new Set(review.approved.keys()), slots };
    },
    async peerLinks(channelId, video) {
      const out: ReleaseRecodeResult["peerLinks"] = [];
      for (const report of await createVideoReservationsShareCoreForProduction().listPeerReports()) {
        const count = report.reservations.filter((r) => r.channelId === channelId && r.video === video && r.state === "in_work").length;
        if (count > 0) out.push({ deviceId: report.deviceId, hostName: report.hostName, kind: "reservation", count });
      }
      for (const report of await createVideoCostsShareCoreForProduction().listPeerReports()) {
        const count = report.runs.filter((r) => r.channelId === channelId && r.video === video).length;
        if (count > 0) out.push({ deviceId: report.deviceId, hostName: report.hostName, kind: "cost_run", count });
      }
      return out;
    },
    storyboards: {
      linked: async (channelId, video) => (await storyboards.read(channelId)).filter((s) => s.video === video).map((s) => s.id),
      setVideo: (channelId, storyboardId, video) => storyboards.setVideo(channelId, storyboardId, video),
    },
    async publishOtherReports() {
      await Promise.allSettled([
        videos.publishOwnReport(),
        import("@/lib/video-costs").then(({ createVideoCostsServiceForProduction }) => createVideoCostsServiceForProduction().publishOwnReport()),
      ]);
    },
    invalidate: (channelId) => invalidatePlanPackages(channelId),
  }).recode(input);
}
