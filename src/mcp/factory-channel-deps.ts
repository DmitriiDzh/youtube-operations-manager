import { agentChannelBranding, createChannelBrandingAgentCore } from "@/lib/channel-branding";
import { createPublishingPlansAgentCore } from "@/lib/publishing-plans";
import { claimTranslationRequest, completeTranslationRequest, failTranslationRequest, listTranslationRequests, reportLocalizationChecks } from "@/lib/localization-review";
import { publishingPlanProgress } from "@/lib/publishing-plan-progress";
import { createChannelPublishingCoverage, invalidateChannelTimeZone } from "@/composition/publishing-coverage";
import { createChannelLocalizationsOperatorCore, operatorChannelLocalizations } from "@/lib/channel-localizations";
import { createGeminiMediaCore } from "@/lib/gemini-media";
import { createSpeechForProduction, voiceRegistryForProduction } from "@/composition/speech";
import { uploadBandwidthReport, uploadBandwidthStatus } from "@/lib/upload-bandwidth";
import { collectLiveEncoderReadings, collectLiveSourceStatus, collectLiveStreamEntries, createLiveSegmentSettingsCore, createLiveStreamsCore, createStreamLocalizationsCore, getLiveStreamsDeviceId, listPeerLiveStreams, localizationsStatusEntry } from "@/lib/live-streams";
import { createGenerationPlansCore } from "@/lib/generation-plans";
import { createStoryboardsServiceForProduction } from "@/lib/storyboards";
import { createVideoProjectsServiceForProduction } from "@/lib/video-projects";
import { listStoryboardTakes } from "@/lib/storyboard-takes";
import { listMediaJobsForAgent } from "@/lib/media-jobs-pool";
import type { FactoryToolDeps } from "./factory-server";

/**
 * The channel part of the Factory Operator's tool wiring (plans, Gemini, live, channel translations, storyboards, video numbers,
 * jobs) -- split from the factory route's own wiring for BL-217, so the channel workers' versions of these tools
 * (`./worker-factory-tools.ts`) run on exactly the same code while nothing in `src/mcp` reaches the media core's session
 * approval, start or stop (`session-approval-inventory.test.ts`). The factory route adds the media, logical-path and channel-list
 * parts.
 */
export type FactoryChannelDeps = Pick<FactoryToolDeps, "plans" | "gemini" | "speech" | "voices" | "live" | "channelLocalizations" | "channelBranding" | "publishingPlans" | "publishingCoverage" | "localizationChecks" | "storyboards" | "videos" | "jobs">;

export function createFactoryChannelDeps(): FactoryChannelDeps {
  return {
    // BL-143 (ADR 0029): generation plans; every write is the factory's.
    plans: {
      create: async (input) => ({ ...(await createGenerationPlansCore().createPlan(input, "factory")) }),
      importPlan: async (input) => ({ ...(await createGenerationPlansCore().importPlan(input, "factory")) }),
      update: async (input) => ({ ...(await createGenerationPlansCore().updatePlan(input, "factory")) }),
      close: async (input) => ({ ...(await createGenerationPlansCore().closePlan(input, "factory")) }),
      get: async (input) => ({ ...(await createGenerationPlansCore().getPlan(input)) }),
      list: async (input) => ({ plans: await createGenerationPlansCore().listPlans(input) }),
      todo: async (input) => ({ ...(await createGenerationPlansCore().todo(input)) }),
      report: async (input) => ({ ...(await createGenerationPlansCore().report(input, "factory")) }),
      runStage: async (input) => ({ ...(await createGenerationPlansCore().runStage(input)) }),
      rerun: async (input) => ({ ...(await createGenerationPlansCore().rerun(input)) }),
      cloneGroup: async (input) => ({ ...(await createGenerationPlansCore().cloneGroup(input, "factory")) }),
      move: async (input) => ({ ...(await createGenerationPlansCore().movePlan(input, "factory")) }),
      requestRecheck: async (input) => ({ ...(await createGenerationPlansCore().requestRecheck(input, "factory")) }),
      withdrawRecheck: async (input) => ({ ...(await createGenerationPlansCore().withdrawRecheck(input, "factory")) }),
    },
    // BL-174 (GEMINI_MEDIA_PLAN.md §2.7): the Gemini module of THIS server process (its job-create lock is shared with the
    // Web routes and the worker); every job is the factory's.
    gemini: {
      getStatus: async () => ({ ...(await createGeminiMediaCore().getStatus()) }),
      createJob: async (input) => ({ ...(await createGeminiMediaCore().createJob(input, "factory")) }),
      getJobs: async (input) => ({ ...(await createGeminiMediaCore().getJobs(input)) }),
    },
    // BL-236 (ADR 0057): speech through Gemini TTS / ElevenLabs and the channel voice registry (src/composition/speech.ts); every
    // job, design and relayed approval is the factory's.
    speech: {
      getStatus: async () => ({ ...(await createSpeechForProduction().getStatus()) }),
      createJob: async (input) => ({ ...(await createSpeechForProduction().createJob(input, "factory")) }),
      getJobs: async (input) => ({ ...(await createSpeechForProduction().getJobs(input)) }),
    },
    voices: {
      list: async (input) => ({ ...(await (await voiceRegistryForProduction()).list(input)) }),
      design: async (input) => ({ ...(await (await voiceRegistryForProduction()).design(input, "factory")) }),
      approve: async (input) => ({ ...(await (await voiceRegistryForProduction()).approve(input, "factory")) }),
      update: async (input) => ({ ...(await (await voiceRegistryForProduction()).update(input)) }),
    },
    // BL-176 (LIVE_STREAMS_PLAN.md §3.4/§3.11): live streams -- this computer's and the other computers' status (fixed codes,
    // never a key or URL), and the Operator's map of videos to original files (it only offers files; the owner builds rotations).
    live: {
      getStatus: async (input) => {
        const now = Date.now();
        const [own, peers, deviceId] = await Promise.all([collectLiveStreamEntries(now), listPeerLiveStreams(), getLiveStreamsDeviceId()]);
        const streams = [
          ...own.map((entry) => ({ device: { deviceId, hostName: null, thisComputer: true }, updatedAt: new Date(now).toISOString(), ...entry })),
          ...peers.flatMap((peer) => peer.streams.map((entry) => ({ device: { deviceId: peer.deviceId, hostName: peer.hostName, thisComputer: false }, updatedAt: peer.updatedAt, ...entry }))),
        ].filter((s) => !input.channelId || s.channelId === input.channelId);
        // BL-205 (1.25.0): this computer's segments -- settings, the running one, the last 30 days and failure stages (codes only).
        const ownChannels = own.filter((e) => !input.channelId || e.channelId === input.channelId).map((e) => e.channelId);
        const segments = (await Promise.all(ownChannels.map((channelId) => createLiveSegmentSettingsCore().view(channelId, now)))).filter(Boolean);
        // BL-207 (1.27.0): this computer's translations -- the set, its warnings and the last step, in codes.
        const localizationsCore = createStreamLocalizationsCore();
        const localizations = await Promise.all(ownChannels.map(async (channelId) => localizationsStatusEntry(channelId, await localizationsCore.view(channelId))));
        // BL-233 (1.37.0): this computer's encoders in numbers, and whether an upload here is limited or held for them.
        const upload = uploadBandwidthReport(uploadBandwidthStatus(now));
        const encoders = (await collectLiveEncoderReadings(now))
          .filter((e) => !input.channelId || e.channelId === input.channelId)
          .map((e) => ({
            channelId: e.channelId,
            helperState: e.helperState,
            running: e.running,
            sampledAt: e.sampledAt === null ? null : new Date(e.sampledAt).toISOString(),
            speed: e.speed,
            recentSpeed: upload?.speeds[e.channelId] ?? null,
            bitrateKbps: e.bitrateKbps,
            targetBitrateKbps: e.targetBitrateKbps,
            outTimeSeconds: e.outTimeSeconds === null ? null : Math.round(e.outTimeSeconds),
            lagSeconds: e.lagSeconds,
            lagEstimated: e.lagEstimated,
          }));
        // The per-stream speeds are on `encoders` (recentSpeed), not repeated here.
        // Asked for one channel (a channel worker always is), another channel's id is not shown.
        const uploadOut = upload
          ? (({ speeds, ...rest }) => (void speeds, { ...rest, heldForChannelId: input.channelId && rest.heldForChannelId !== input.channelId ? null : rest.heldForChannelId }))(upload)
          : null;
        // BL-234 (1.38.0): this computer's source per stream -- videos | segments, the selection, the library and, in segments mode,
        // the segment and track playing (from the generator's sidecar). Local reads only.
        const sources = await collectLiveSourceStatus(ownChannels);
        return { streams, segments, localizations, encoders, upload: uploadOut, sources };
      },
      mapSources: async (input) => ({ results: await createLiveStreamsCore().setSources(input.channelId, { items: input.items }, "factory") }),
      // BL-207: the stream's translations, replaced as a whole (refused whole, nothing half-saved); local only.
      setLocalizations: async (input) => ({ ...(await createStreamLocalizationsCore().save(input.channelId, input.localizations, "factory")) }),
    },
    // BL-210 (CHANNEL_LOCALIZATIONS_PLAN.md §5, ADR 0047): a channel's own translations -- the Operator's surface of the module has
    // no apply, so nothing here reaches a YouTube write; the save is local, the get reads YouTube once (1 unit).
    channelLocalizations: {
      get: async (input) => operatorChannelLocalizations(createChannelLocalizationsOperatorCore(), input.channelId),
      save: async (input) => ({ ...(await createChannelLocalizationsOperatorCore().save(input.channelId, input.localizations)) }),
    },
    // BL-223 (CHANNEL_BRANDING_PLAN.md §5, ADR 0050): a channel's description, keywords and banner -- the agent surface of the module
    // has no apply, so nothing here reaches a YouTube write; the save is local, the get reads YouTube once (1 unit).
    channelBranding: {
      get: async (input) => agentChannelBranding(createChannelBrandingAgentCore(), input.channelId),
      save: async (input, by = "factory") => ({ ...(await createChannelBrandingAgentCore().save(input, by)) }),
    },
    // BL-225 (ADR 0051): the weekly publishing plan -- the agents' surface of the module has no decision function, so nothing here
    // approves a slot or reaches YouTube; the save is synced to the other computers.
    publishingPlans: {
      save: async (input, by = "factory") => {
        const result = { ...(await createPublishingPlansAgentCore(publishingPlanProgress).save(input, by)) };
        // BL-235: the plan's zone is the channel's coverage zone -- read it again on the next coverage read.
        const channelId = (input as { channelId?: unknown } | null)?.channelId;
        if (typeof channelId === "string") invalidateChannelTimeZone(channelId);
        return result;
      },
      get: async (input) => ({ ...(await createPublishingPlansAgentCore(publishingPlanProgress).get(input)) }),
      list: async (input) => ({ ...(await createPublishingPlansAgentCore(publishingPlanProgress).list(input)) }),
    },
    // BL-235: the shared publishing coverage in the channel's zone (the weekly plan's, else the owner's) -- a local read.
    publishingCoverage: {
      get: async (input) => ({ ...(await createChannelPublishingCoverage().get(input)) }),
    },
    // BL-227 (ADR 0052): check reports on change sets -- a report decides nothing (only the owner approves, in the Web UI).
    localizationChecks: {
      report: async (input, by = "factory") => ({ ...(await reportLocalizationChecks(input, by)) }),
      listRequests: async (input) => ({ ...(await listTranslationRequests(input)) }),
      claimRequest: async (input, by = "factory") => ({ ...(await claimTranslationRequest(input, by)) }),
      completeRequest: async (input, by = "factory") => ({ ...(await completeTranslationRequest(input, by)) }),
      failRequest: async (input, by = "factory") => ({ ...(await failTranslationRequest(input, by)) }),
    },
    // BL-184 (STORYBOARD_PLAN.md §2.6): storyboards; every write is the Operator's (the owner decides in the Web UI only).
    storyboards: {
      create: async (input) => ({ ...(await createStoryboardsServiceForProduction().create(input)) }),
      update: async (input) => ({ ...(await createStoryboardsServiceForProduction().update(input)) }),
      get: async (input) => ({ ...(await createStoryboardsServiceForProduction().get(input)) }),
      list: async (input) => ({ ...(await createStoryboardsServiceForProduction().list(input)) }),
      submit: async (input) => ({ ...(await createStoryboardsServiceForProduction().submit(input)) }),
      reply: async (input) => ({ ...(await createStoryboardsServiceForProduction().operatorReply(input)) }),
      // BL-189 (FO-REQ-0025 B): each pick is checked against the storyboard's takes on every computer (storyboard-takes).
      attachRender: async (input) => {
        const ref = (input ?? {}) as { channelId?: unknown; storyboardId?: unknown };
        // Read once per call (independent review): every pick is checked against the same list.
        let takes: ReturnType<typeof listStoryboardTakes> | null = null;
        const isTake = async (take: { source: "media" | "gemini"; jobId: string }, versionNumber: number, segmentId: string) => {
          if (typeof ref.channelId !== "string" || typeof ref.storyboardId !== "string") return false;
          takes ??= listStoryboardTakes(ref.channelId, ref.storyboardId);
          return (await takes).some((t) => t.source === take.source && t.jobId === take.jobId && t.versionNumber === versionNumber && t.segmentId === segmentId);
        };
        return { ...(await createStoryboardsServiceForProduction().attachRender(input, isTake)) };
      },
    },
    // BL-194 (ADR 0040): video numbers -- reserved on this computer, listed from every computer, the workspace and the uploads.
    videos: {
      create: async (input) => ({ ...(await createVideoProjectsServiceForProduction().createVideo(input)) }),
      list: async (input) => ({ ...(await createVideoProjectsServiceForProduction().listVideos(input)) }),
      // BL-194 stage 3 (ADR 0041): loaded on use, so a broken cost module never takes the Factory endpoint down (AGENTS.md §M).
      cost: async (input) => ({ ...(await (await import("@/lib/video-costs")).createVideoCostsServiceForProduction().videoCost(input)) }),
    },
    // BL-188 (SHARED_MEDIA_JOBS_PLAN.md §2.7): every computer's media jobs, read-only, in the shared shape (codes only).
    jobs: {
      list: async (input) => ({ ...(await listMediaJobsForAgent(input)) }),
    },
  };
}
