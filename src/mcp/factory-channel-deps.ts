import { agentChannelBranding, createChannelBrandingAgentCore } from "@/lib/channel-branding";
import { createChannelLocalizationsOperatorCore, operatorChannelLocalizations } from "@/lib/channel-localizations";
import { createGeminiMediaCore } from "@/lib/gemini-media";
import { collectLiveStreamEntries, createLiveSegmentSettingsCore, createLiveStreamsCore, createStreamLocalizationsCore, getLiveStreamsDeviceId, listPeerLiveStreams, localizationsStatusEntry } from "@/lib/live-streams";
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
export type FactoryChannelDeps = Pick<FactoryToolDeps, "plans" | "gemini" | "live" | "channelLocalizations" | "channelBranding" | "storyboards" | "videos" | "jobs">;

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
        return { streams, segments, localizations };
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
