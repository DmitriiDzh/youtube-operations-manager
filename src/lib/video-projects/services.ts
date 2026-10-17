import { parseWithSchema } from "@/lib/shared-domain";
import { VIDEO_RESERVATIONS_REPORT_FORMAT, VIDEO_RESERVATIONS_REPORT_VERSION, type VideoReservationsReport } from "@/lib/sync-gateway";
import { DomainError, isDomainError, type OwnReservation, type VideoProject, type VideoProjectsDeps } from "./contracts";
import { buildVideoList, knownNumbers, nextVideoNumber, type VideoListInput } from "./numbering";
import { createVideoInputSchema, jobVideoInputSchema, listVideosInputSchema, videoNumberSchema, videoRefInputSchema } from "./schemas";

// BL-194 stage 1 (VIDEO_COST_PLAN.md §2, ADR 0040): reserving a number, the channel's list of videos with its conflicts, the
// losing computer's renumbering, and the one check every link to a video passes (`assertAttachable`). The Web routes, the API
// and the Factory API all call these; every one of them checks the channel is connected on this computer (AGENTS.md §F).

export type VideoListResult = {
  channelId: string;
  videos: VideoProject[];
  /** Whether the channel workspace could be read (its folders and registry are then in the list). */
  workspace: "ok" | "not_configured" | "unavailable";
  /** What «Новый ролик» would give now; null while the workspace cannot be read. */
  nextVideo: string | null;
};

const unavailable = (channelId: string, reason: string) =>
  new DomainError({ code: "video_workspace_unavailable", message: `Video numbers for ${channelId} need the channel connected here with a readable workspace folder: ${reason}`, details: { channelId, reason } });

export function createVideoProjectsService(deps: VideoProjectsDeps) {
  const log = (line: string) => deps.log?.(line);
  let lastPublished: string | null = null;

  async function requireConnected(channelId: string) {
    if (!(await deps.isChannelConnected(channelId))) throw unavailable(channelId, "the channel is not connected on this computer");
  }

  /** This computer's report, rebuilt from its own reservations (every channel), handed to the sync family when it changed. */
  async function publishOwnReport(force = false): Promise<void> {
    const [device, reservations] = await Promise.all([deps.ownDevice(), deps.store.list()]);
    const body = JSON.stringify({ hostName: device.hostName, reservations });
    if (!force && body === lastPublished) return;
    const report: VideoReservationsReport = {
      format: VIDEO_RESERVATIONS_REPORT_FORMAT,
      version: VIDEO_RESERVATIONS_REPORT_VERSION,
      deviceId: device.deviceId,
      hostName: device.hostName,
      updatedAt: deps.now().toISOString(),
      reservations: reservations.map((r) => ({ ...r })),
    };
    await deps.publishReport(report);
    lastPublished = body;
  }

  /** Everything the list is built from. `folders`/`registry` are null when the workspace cannot be read. */
  async function gather(channelId: string): Promise<{ input: VideoListInput; workspace: VideoListResult["workspace"]; workspaceReason: string | null }> {
    const [device, own, peers, uploads, workspace] = await Promise.all([
      deps.ownDevice(),
      deps.store.list(channelId),
      deps.peers(),
      deps.uploads(channelId),
      deps.workspace(channelId).catch((error: unknown) => ({ status: "unavailable" as const, reason: error instanceof Error ? error.message : String(error) })),
    ]);
    const input: VideoListInput = {
      channelId,
      own: { deviceId: device.deviceId, hostName: device.hostName, reservations: own },
      peers: peers.filter((p) => p.deviceId !== device.deviceId).map((p) => ({ deviceId: p.deviceId, hostName: p.hostName, reservations: p.reservations })),
      folders: workspace.status === "ok" ? workspace.folders : null,
      registry: workspace.status === "ok" ? workspace.registry : null,
      uploads,
    };
    const reason = workspace.status === "unavailable" ? workspace.reason : workspace.status === "not_configured" ? "no workspace folder is set for the channel on this computer" : null;
    return { input, workspace: workspace.status, workspaceReason: reason };
  }

  /** A new reservation of the next free number (under the lock, so two at once get two numbers). */
  async function reserveNext(channelId: string, workingTitle: string | null): Promise<{ video: string; gathered: Awaited<ReturnType<typeof gather>> }> {
    const gathered = await gather(channelId);
    if (gathered.workspace !== "ok") throw unavailable(channelId, gathered.workspaceReason ?? "the workspace folder cannot be read");
    const video = nextVideoNumber(knownNumbers(gathered.input));
    const row: OwnReservation = { channelId, video, workingTitle, reservedAt: deps.now().toISOString(), state: "in_work", cancelledAt: null, replacedBy: null };
    if (!(await deps.store.insert(row))) throw new DomainError({ code: "validation_failed", message: `${video} is already reserved on this computer`, details: { channelId, video } });
    gathered.input.own.reservations.push(row);
    return { video, gathered };
  }

  const projectOf = (gathered: Awaited<ReturnType<typeof gather>>, video: string): VideoProject => {
    const found = buildVideoList(gathered.input).find((v) => v.video === video);
    if (!found) throw new DomainError({ code: "video_not_found", message: `No video ${video} in ${gathered.input.channelId}`, details: { channelId: gathered.input.channelId, video } });
    return found;
  };

  /**
   * A video of the channel that can be linked to now: known from a reservation of any computer, a `MMDD Vn` folder, the registry
   * or an upload; not cancelled; not reserved by two computers at once. Returns the number; throws `video_not_found` /
   * `video_in_dispute`. A number reserved on this computer alone is accepted without reading the workspace.
   */
  async function assertAttachable(channelId: string, raw: unknown): Promise<string> {
    const video = parseWithSchema(videoNumberSchema, raw, "video number");
    const [device, own, peers] = await Promise.all([deps.ownDevice(), deps.store.list(channelId), deps.peers()]);
    const mine = own.some((r) => r.video === video && r.state === "in_work");
    const peerActive = peers.some((p) => p.deviceId !== device.deviceId && p.reservations.some((r) => r.channelId === channelId && r.video === video && r.state === "in_work"));
    if (mine && !peerActive) return video;
    const gathered = await gather(channelId);
    const found = buildVideoList(gathered.input).find((v) => v.video === video);
    if (!found || found.state === "cancelled") {
      throw new DomainError({ code: "video_not_found", message: `${video} is not a video of ${channelId} that can be linked (factory_video_list).`, details: { channelId, video, reason: found ? "cancelled" : "unknown" } });
    }
    if (found.conflict) {
      throw new DomainError({
        code: "video_in_dispute",
        message: `${video} was reserved on two computers; nothing is linked to it until the losing computer takes another number.`,
        details: { channelId, video, winnerDeviceId: found.conflict.winnerDeviceId },
      });
    }
    return video;
  }

  /** An inherited video: linked only when it can be (otherwise logged and left unlinked -- never a refusal). */
  async function inherited(channelId: string, video: string | null, from: string): Promise<string | null> {
    if (!video) return null;
    try {
      return await assertAttachable(channelId, video);
    } catch (error) {
      log(`[video-projects] ${from}'s video ${video} is not linked to this job: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  return {
    publishOwnReport: () => publishOwnReport(true),

    /** «Новый ролик» / `factory_video_create`: the next free number of the channel, with an optional working title. */
    async createVideo(raw: unknown): Promise<{ video: VideoProject }> {
      const input = parseWithSchema(createVideoInputSchema, raw, "new video");
      await requireConnected(input.channelId);
      const title = input.workingTitle ? input.workingTitle : null;
      const { video, gathered } = await deps.withLock(() => reserveNext(input.channelId, title));
      await publishOwnReport();
      return { video: projectOf(gathered, video) };
    },

    /** The channel's videos (every computer's reservations, folders, registry, uploads), highest number first. */
    async listVideos(raw: unknown): Promise<VideoListResult> {
      const input = parseWithSchema(listVideosInputSchema, raw, "video list");
      await requireConnected(input.channelId);
      const gathered = await gather(input.channelId);
      // A report lost on disk (or never written by a build before this one) is written again from the database.
      await publishOwnReport().catch((error: unknown) => log(`[video-projects] report not published: ${error instanceof Error ? error.message : String(error)}`));
      const videos = buildVideoList(gathered.input).filter((v) => !input.state || v.state === input.state);
      return {
        channelId: input.channelId,
        videos,
        workspace: gathered.workspace,
        nextVideo: gathered.workspace === "ok" ? nextVideoNumber(knownNumbers(gathered.input)) : null,
      };
    },

    /**
     * The losing computer of a duplicate takes the next free number -- only when the owner (or the Operator) asks. Its reservation
     * of the disputed number is released (kept as cancelled, with the number taken instead), the working title moves along.
     */
    async renumber(raw: unknown): Promise<{ video: VideoProject; replaced: string }> {
      const input = parseWithSchema(videoRefInputSchema, raw, "renumber");
      await requireConnected(input.channelId);
      const result = await deps.withLock(async () => {
        const before = await gather(input.channelId);
        const current = buildVideoList(before.input).find((v) => v.video === input.video);
        const mine = before.input.own.reservations.find((r) => r.video === input.video && r.state === "in_work");
        if (!current?.conflict || !mine || !current.conflict.thisComputerLoses) {
          throw new DomainError({ code: "validation_failed", message: `${input.video} is not a number this computer lost to another computer; nothing was changed.`, details: { channelId: input.channelId, video: input.video } });
        }
        const { video, gathered } = await reserveNext(input.channelId, mine.workingTitle);
        await deps.store.cancel(input.channelId, input.video, { cancelledAt: deps.now().toISOString(), replacedBy: video });
        const released = gathered.input.own.reservations.find((r) => r.video === input.video);
        if (released) Object.assign(released, { state: "cancelled", replacedBy: video });
        return { video, gathered };
      });
      await publishOwnReport();
      return { video: projectOf(result.gathered, result.video), replaced: input.video };
    },

    /** Gives up a video reserved on THIS computer (its number is never given again). */
    async cancelVideo(raw: unknown): Promise<{ video: VideoProject }> {
      const input = parseWithSchema(videoRefInputSchema, raw, "cancel video");
      await requireConnected(input.channelId);
      const done = await deps.withLock(() => deps.store.cancel(input.channelId, input.video, { cancelledAt: deps.now().toISOString(), replacedBy: null }));
      if (!done) throw new DomainError({ code: "video_not_found", message: `${input.video} is not a video in work reserved on this computer`, details: { channelId: input.channelId, video: input.video } });
      await publishOwnReport();
      return { video: projectOf(await gather(input.channelId), input.video) };
    },

    assertAttachable,

    /**
     * The video a new job is made for (VIDEO_COST_PLAN.md §2): an explicit `videoNumber` must be attachable (else the job is
     * refused); otherwise the job inherits its storyboard's video, else its plan's. An inherited video that cannot be linked, or a
     * lookup that fails, leaves the job unlinked -- the media modules keep working when this module fails (criterion 8).
     */
    async resolveJobVideo(raw: unknown): Promise<string | null> {
      const input = parseWithSchema(jobVideoInputSchema, raw, "job video");
      if (input.videoNumber) return assertAttachable(input.channelId, input.videoNumber);
      try {
        if (input.storyboardId) {
          const video = await inherited(input.channelId, await deps.storyboardVideo(input.channelId, input.storyboardId), `storyboard ${input.storyboardId}`);
          if (video) return video;
        }
        if (input.planId) {
          const plan = await deps.planVideo(input.planId);
          if (plan && plan.channelId === input.channelId) return await inherited(input.channelId, plan.video, `plan ${input.planId}`);
        }
      } catch (error) {
        log(`[video-projects] the job's video could not be looked up; the job is not linked: ${isDomainError(error) ? error.message : error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    },
  };
}

export type VideoProjectsService = ReturnType<typeof createVideoProjectsService>;
