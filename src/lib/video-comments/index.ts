import { createChannelAccessCore } from "@/lib/channel-access";
import { createQuotaGuardCore } from "@/lib/quota-guard";
import { failureKind, getAuthenticatedYoutube, getVideoCommentCounts, listOwnVideoComments } from "@/lib/youtube-read-gateway";
import { quotaScoped } from "@/lib/youtube-quota";
import { createVideoCommentStoreAdapter } from "./adapters/store";
import { createVideoCommentServices, gateCommentCollection } from "./services";

/** The Pacific calendar date (YouTube's day boundary for quota and Analytics). */
const pacificDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });

// BL-171 (docs/roadmap/plans/VIDEO_COMMENTS_PLAN.md): the real wiring. Reads go through the read gateway as the channel's signed-in user
// (the Data API reads switch applies inside the client), the collection behind the Data API quota reserve, labelled in the quota history.
export function createVideoCommentsCore() {
  const adapter = createVideoCommentStoreAdapter();
  const services = createVideoCommentServices({
    clock: { now: () => new Date() },
    toPacificDate: (at) => pacificDateFormatter.format(at),
    channelAccess: createChannelAccessCore(),
    listVideos: adapter.listVideos,
    youtube: {
      commentCounts: async (credentialRef, videoIds) => getVideoCommentCounts(await getAuthenticatedYoutube(credentialRef.userId), videoIds),
      comments: async (credentialRef, videoId, channelId) => listOwnVideoComments(await getAuthenticatedYoutube(credentialRef.userId), videoId, channelId),
    },
    failureKind,
    store: adapter.store,
  });
  const guard = createQuotaGuardCore();
  return {
    collectDueComments: quotaScoped(gateCommentCollection(guard, services.collectDueComments), { kind: "comment_collection", id: null, label: "Comment collection" }),
    listStoredComments: services.listStoredComments,
  };
}

export type VideoCommentsCore = ReturnType<typeof createVideoCommentsCore>;
export { listStoredCommentsInputSchema } from "./services";
