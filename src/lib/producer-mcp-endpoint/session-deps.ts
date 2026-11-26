import type { ProducerSession } from "@/mcp/server";
import { runInAgentSession } from "@/lib/agent-session";
import { MILESTONE_DAYS, hasFinalPublishDate, isMilestoneDue, milestoneWindow } from "@/lib/analytics";
import { createAgentProposalSubmitCore } from "@/lib/agent-proposals";
import { createChannelConnectionsCore, resolveConnectedChannelUser } from "@/lib/channel-connections";
import { createVideoThumbnailsCore } from "@/lib/video-thumbnails";
import { createChannelWorkspacesCore } from "@/lib/channel-workspaces";
import {
  getLatestChannelMetricCollectedAt,
  getStoredChannel,
  insertProducerCallLogEntry,
  listChannelMetricsInRange,
  listStoredVideosByChannel,
  listVideoMilestoneTotals,
} from "@/lib/db";
import { createPortfolioOverviewServices, createUploadMilestonesServices } from "@/lib/portfolio-overview";
import { createReachReportsCore } from "@/lib/reach-reports";
import { PRODUCER_API_VERSION } from "@/mcp/producer-tools";
import { createLiveAnalyticsCore } from "@/lib/live-analytics";
import { createPackageCaptionsCore, createPackageCategoryCore, createPackageLocalizationsCore, createPackageMetadataCore, createUploadQueueControlCore, createVideoPublishingCheckCore, listUploadPlaylistRecords, type SlotDecision } from "@/lib/publishing";
import { createVideoPlaylistMembershipCore } from "@/lib/video-playlist-membership";
import { createClipReviewsProducerCore } from "@/lib/clip-reviews";
import { createImageReviewsProducerCore } from "@/lib/image-reviews";
import type { ProducerMcpSession } from "./index";
import type { PublishingPlansProducerSurface } from "@/lib/publishing-plans";

// BL-161 / BL-166: the real deps of a Producer session -- what `src/app/api/mcp/producer/route.ts` hands the MCP server. Kept here,
// not in the route file (a route may only export its handlers), so the wiring is tested on a real database
// (`session-deps.test.ts`), not only through fakes.

/** Every channel in Settings → Channels on this device, with this device's workspace folder (or null). */
async function listChannels(): Promise<Array<{ channelId: string; title: string; workspace: string | null }>> {
  const [connected, workspaces] = await Promise.all([createChannelConnectionsCore().listConnectedChannels(), createChannelWorkspacesCore().listWorkspaces()]);
  const pathByChannel = new Map(workspaces.map((entry) => [entry.channelId, entry.path]));
  return connected.map((channel) => ({ channelId: channel.channelId, title: channel.title, workspace: pathByChannel.get(channel.channelId) ?? null }));
}

/** The Google account a channel is connected under here (`resolveConnectedChannelUser`, the one definition). */
const resolveChannelUser = resolveConnectedChannelUser;

/**
 * `slotDecisions` (BL-239): the weekly plan's slot decisions, from the composition layer (the Producer route passes them), so an
 * upload the Producer adds gets a date only from a slot the owner approved, and a vetoed slot is refused.
 */
export function createProducerSessionDeps(
  session: ProducerMcpSession,
  options: {
    slotDecisions?: (channelId: string) => Promise<Map<string, SlotDecision>>;
    publishingPlans?: () => PublishingPlansProducerSurface;
    /** BL-271: the wait core (the route passes `@/composition/wait-targets`' production wait). */
    wait?: () => ProducerSession["wait"];
  } = {}
): ProducerSession {
  const portfolio = createPortfolioOverviewServices({
    listChannels,
    async loadChannel(channel, range) {
      const userId = await resolveChannelUser(channel.channelId);
      const reach = userId
        ? await runInAgentSession({ tokenId: session.tokenId, channelId: channel.channelId, userId }, () =>
            createReachReportsCore().getChannelReach({ credentialRef: { userId }, channelId: channel.channelId, startDate: range.startDate, endDate: range.endDate })
          ).catch(() => null)
        : null;
      const [metrics, videos, stored, lastAnalyticsCollectedAt] = await Promise.all([
        listChannelMetricsInRange(channel.channelId, range),
        listStoredVideosByChannel(channel.channelId),
        getStoredChannel(channel.channelId),
        getLatestChannelMetricCollectedAt(channel.channelId),
      ]);
      return {
        channelId: channel.channelId,
        title: channel.title,
        metrics,
        reach: reach
          ? { state: reach.state, impressions: reach.totals.impressions, ctr: reach.totals.ctr, coveredThrough: reach.coverage.lastDate, daysWithData: reach.daily.length }
          : null,
        videoPublishedAt: videos.map((video) => video.publishedAt),
        lastVideoSyncAt: stored?.lastSyncedAt ?? null,
        lastAnalyticsCollectedAt,
      };
    },
  });
  // BL-166: each channel's uploads with their stored day-7 / day-28 milestones, and Reach over each window -- read inside the channel's
  // agent scope, like the portfolio's Reach, so it passes the same channel check as the channel's own agent.
  const uploadMilestones = createUploadMilestonesServices({
    milestoneDays: MILESTONE_DAYS,
    windowOf: milestoneWindow,
    isDue: (windowEnd) => isMilestoneDue(windowEnd, new Date()),
    isPublished: (video) => hasFinalPublishDate({ videoId: "", ...video }),
    listChannels,
    async listVideos(channelId) {
      const stored = await getStoredChannel(channelId);
      if (!stored?.lastSyncedAt) return null;
      return (await listStoredVideosByChannel(channelId)).map((video) => ({
        videoId: video.videoId,
        title: video.title,
        publishedAt: video.publishedAt ?? null,
        privacyStatus: video.privacyStatus ?? null,
        liveBroadcastContent: video.liveBroadcastContent ?? null,
        durationSeconds: video.durationSeconds ?? null,
      }));
    },
    listStoredMilestones: (channelId, videoIds) => listVideoMilestoneTotals(channelId, videoIds),
    async readReach(channelId, windows) {
      const userId = await resolveChannelUser(channelId);
      if (!userId) return null;
      return runInAgentSession({ tokenId: session.tokenId, channelId, userId }, () =>
        createReachReportsCore().getVideoWindowsReach({ credentialRef: { userId }, channelId, windows })
      );
    },
  });
  // BL-163: the Producer's side of the proposal store only; approving and applying are Web-UI routes.
  const proposals = createAgentProposalSubmitCore();
  // BL-239 (ADR 0059, owner msgs 3928/3930): this computer's upload queue -- the only wiring of the queue control to an MCP
  // endpoint (no-agent-upload-tool.test.ts). "Connected here" is the Producer's own rule (Settings → Channels).
  const queue = () => createUploadQueueControlCore({ channelUser: resolveChannelUser, ...(options.slotDecisions ? { slotDecisions: options.slotDecisions } : {}) });
  const producer = { kind: "producer" as const, tokenId: session.tokenId };
  // BL-267: the Producer's plan writes (propose, a real move) pass the device mutation gate like its other writes (operation lock,
  // recovery mode); reads and dry runs do not.
  const mutationGate = async () => {
    const { rawSqlClient } = await import("@/lib/db");
    const { assertDeviceAvailableForMutation } = await import("@/lib/device-mutation-gate");
    await assertDeviceAvailableForMutation(rawSqlClient);
  };
  const plansOf = (): PublishingPlansProducerSurface => {
    if (!options.publishingPlans) throw new Error("The weekly plan is not wired to this Producer session.");
    return options.publishingPlans();
  };
  return {
    tokenId: session.tokenId,
    reverify: () => session.reverify(),
    resolveChannelUser,
    async recordCall(entry) {
      session.noteRecorded(entry.tool, entry.channelId);
      await insertProducerCallLogEntry({ at: new Date(), ...entry });
    },
    listChannels,
    portfolioOverview: async (input) => ({ ...(await portfolio.getOverview(input)) }),
    uploadMilestones: async (input) => ({ ...(await uploadMilestones.getUploadMilestones(input)) }),
    liveAnalytics: async (input) => ({ ...(await createLiveAnalyticsCore().portfolio(input, await listChannels())) }),
    proposals: {
      submit: async (input) => ({ ...(await proposals.submitProducerProposal(input, { agentApiVersion: PRODUCER_API_VERSION })) }),
      list: async (input) => ({ ...(await proposals.listProducerProposals(input)) }),
      markDone: async (input) => ({ ...(await proposals.markProducerProposalsDone(input)) }),
    },
    uploadQueue: {
      list: async () => ({ ...(await queue().list()) }),
      add: async (input) => ({ ...(await queue().add(input, producer)) }),
      move: async (input) => ({ ...(await queue().move(input, producer)) }),
      cancel: async (input) => ({ ...(await queue().cancel(input, producer)) }),
    },
    // BL-255 (ADR 0069, owner msgs 4380/4383): the thumbnail writer -- the only wiring of it to an MCP endpoint.
    thumbnails: {
      replace: async (input) => ({ ...(await createVideoThumbnailsCore().replace(input, producer)) }),
    },
    // BL-265 (ADR 0072 §5, owner TG 4578/4581): the packaging fix -- the only wiring of it to an MCP endpoint; actor producer (no
    // conflict override).
    packageMetadata: {
      update: async (input) =>
        // Owner TG 4839/4842 (ADR 0072 amendment): `localizations: true` fixes the package's translations instead (one write per call).
        input.localizations === true
          ? input.dryRun === true
            ? { ...(await createPackageLocalizationsCore().preview(input.channelId, { video: input.video }, { kind: "producer" })) }
            : {
                ...(await createPackageLocalizationsCore().apply(
                  input.channelId,
                  { video: input.video, ...(input.expectedManifestSha256 !== undefined ? { expectedManifestSha256: input.expectedManifestSha256 } : {}) },
                  { kind: "producer" }
                )),
              }
          : input.dryRun === true
          ? { ...(await createPackageMetadataCore().preview(input.channelId, { video: input.video }, { kind: "producer" })) }
          : {
              ...(await createPackageMetadataCore().apply(
                input.channelId,
                { video: input.video, ...(input.expectedManifestSha256 !== undefined ? { expectedManifestSha256: input.expectedManifestSha256 } : {}) },
                { kind: "producer" }
              )),
            },
    },
    // BL-269 (ADR 0074 §8, §10; owner TG 4590/4592/4660): a package's captions onto its uploaded video -- the only wiring of the
    // package-captions service to an MCP endpoint; actor producer.
    captions: {
      add: async ({ channelId, video, dryRun, overwrite, expectedManifestSha256, expectedTrackId }) =>
        dryRun === true
          ? { ...(await createPackageCaptionsCore().preview(channelId, { video, overwrite: overwrite === true }, { kind: "producer" })) }
          : {
              ...(await createPackageCaptionsCore().apply(
                channelId,
                {
                  video,
                  overwrite: overwrite === true,
                  ...(expectedManifestSha256 !== undefined ? { expectedManifestSha256 } : {}),
                  ...(expectedTrackId !== undefined ? { expectedTrackId } : {}),
                },
                { kind: "producer" }
              )),
            },
    },
    // BL-267 (ADR 0073 §5, owner TG 4630/4636): the weekly plan -- reads, the template proposal and the immediate move; the only
    // wiring of the plan's Producer surface to an MCP endpoint (no approve, veto or template decision is reachable).
    plans: {
      templateGet: async (input) => ({ ...(await plansOf().templateGet(input.channelId)) }),
      templatePropose: async (input) => {
        await mutationGate();
        return { ...(await plansOf().templatePropose(input.channelId, input.template)) };
      },
      get: async (input) => ({ ...(await plansOf().get(input)) }),
      list: async (input) => ({ ...(await plansOf().list(input)) }),
      move: async (input) => {
        if (input.dryRun !== true) await mutationGate();
        const { channelId, ...rest } = input;
        return { ...(await plansOf().move(channelId, rest)) };
      },
    },
    // BL-271 (WAIT_TOOLS_PLAN.md §3.2, ADR 0075): the wait, read-only; the tool itself lets through only upload and restart.
    wait: {
      waitFor: async (input, scope) => {
        if (!options.wait) throw new Error("The wait is not wired to this Producer session.");
        return { ...(await options.wait().waitFor(input, scope)) };
      },
    },
    // BL-241 (ADR 0061): the clips for review -- the module's Producer surface only (submit, withdraw, list, get); the owner's
    // decision is reachable only from the Web UI's clip-review routes (clip-reviews/boundaries.test.ts).
    clipReviews: {
      submit: async (input) => ({ ...(await createClipReviewsProducerCore().submit(input, { tokenId: session.tokenId })) }),
      withdraw: async (input) => ({ ...(await createClipReviewsProducerCore().withdraw(input)) }),
      list: async (input) => ({ ...(await createClipReviewsProducerCore().list(input)) }),
      get: async (input) => ({ ...(await createClipReviewsProducerCore().get(input)) }),
    },
    // BL-272 (ADR 0076): the master still images for review -- the module's Producer surface only (submit, withdraw, list, get); the
    // owner's answers are reachable only from the Web UI's image-review routes (image-reviews/boundaries.test.ts).
    imageReviews: {
      submit: async (input) => ({ ...(await createImageReviewsProducerCore().submit(input, { tokenId: session.tokenId })) }),
      withdraw: async (input) => ({ ...(await createImageReviewsProducerCore().withdraw(input)) }),
      list: async (input) => ({ ...(await createImageReviewsProducerCore().list(input)) }),
      get: async (input) => ({ ...(await createImageReviewsProducerCore().get(input)) }),
    },
    // Package playlists (owner TG 4858/4859): a video's playlists on its channel -- read-only; the channel must be connected here
    // and the video that channel's (checked before any YouTube call), then the identity check on the channel's grant.
    videoPlaylists: {
      get: async (input) => ({ ...(await createVideoPlaylistMembershipCore({ channelUser: resolveChannelUser, uploadRecords: listUploadPlaylistRecords }).videoPlaylists(input)) }),
    },
    // BL-279 (owner TG 4963/4964, ADR 0072 amendment 2): the category fix -- the only wiring of it to an MCP endpoint; actor producer.
    videoCategory: {
      fix: async ({ channelId, dryRun, videoIds, expectedCategoryId }) =>
        dryRun === true
          ? { ...(await createPackageCategoryCore().preview(channelId, { kind: "producer" })) }
          : { ...(await createPackageCategoryCore().apply(channelId, { ...(videoIds !== undefined ? { videoIds } : {}), ...(expectedCategoryId !== undefined ? { expectedCategoryId } : {}) }, { kind: "producer" })) },
    },
    // BL-279 (owner TG 4964): the publishing fields check -- read-only.
    publishingCheck: {
      check: async (input) => ({ ...(await createVideoPublishingCheckCore().check(input, { kind: "producer" })) }),
    },
  };
}
