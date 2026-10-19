import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getChannelExpectedLanguages, latestLiveStreamEvent, listLiveStreamEvents } from "@/lib/db";
import { createLiveStreamVideoFields } from "@/composition/live-stream-video-fields";
import {
  collectLiveStreamEntries,
  listPeerLiveStreams,
  createLiveBroadcastsCore,
  createLiveStreamsCore,
  createLiveStreamsSettingsCore,
  createRotationPickerCore,
  createStreamSupervisorCore,
  createStreamVideoSettingsCore,
  isDomainError,
} from "@/lib/live-streams";

// BL-176 (LIVE_STREAMS_PLAN.md §3.9/§3.12): the owner's routes for a channel's live stream. Every handler: a Web session
// (401), the channel must be the active one (ADR 0004, 403), a thin call into the module, DomainError -> status. Only
// start / go-live / stop / edit write to YouTube (through the module's gateway adapter, with Live writes and the identity
// check); no response ever carries the stream key. Mutating methods pass `src/proxy.ts`'s gate like every /api route.

export type LiveStreamRouteCore = {
  overview(channelId: string): Promise<unknown>;
  saveSettings(channelId: string, body: unknown): Promise<unknown>;
  /** BL-186: the stream's video and broadcast settings and its thumbnail -- local only, never a YouTube write. */
  saveVideoSettings(channelId: string, body: unknown): Promise<unknown>;
  setThumbnail(channelId: string, bytes: Uint8Array): Promise<unknown>;
  clearThumbnail(channelId: string): Promise<void>;
  readThumbnail(channelId: string): Promise<{ kind: "jpeg" | "png"; bytes: Uint8Array } | null>;
  addVideo(channelId: string, body: unknown): Promise<unknown>;
  addVideos(channelId: string, body: unknown): Promise<unknown>;
  listCandidates(channelId: string, options: { showAll: boolean }): Promise<unknown>;
  removeVideo(channelId: string, videoId: string): Promise<void>;
  reorder(channelId: string, body: unknown): Promise<void>;
  overrideGuard(channelId: string, videoId: string, body: unknown): Promise<void>;
  clearGuardOverride(channelId: string, videoId: string): Promise<void>;
  previewStart(channelId: string): Promise<unknown>;
  start(channelId: string, credentialRef: { userId: string }): Promise<unknown>;
  goLive(channelId: string, credentialRef: { userId: string }): Promise<unknown>;
  stop(channelId: string, credentialRef: { userId: string }, body: unknown): Promise<unknown>;
  restart(channelId: string): Promise<unknown>;
  previewEdit(channelId: string, credentialRef: { userId: string }, body: unknown): Promise<unknown>;
  edit(channelId: string, credentialRef: { userId: string }, body: unknown): Promise<unknown>;
  /** BL-186 stage 3, «Применить снова»: the dry run (no call), then the owner's apply (YouTube writes). */
  previewApplyVideoSettings(channelId: string): Promise<unknown>;
  applyVideoSettings(channelId: string, credentialRef: { userId: string }): Promise<unknown>;
};


export type LiveStreamRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  core: LiveStreamRouteCore;
};

function objectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export function createLiveStreamRouteCore(): LiveStreamRouteCore {
  const rotation = createLiveStreamsCore();
  const broadcasts = createLiveBroadcastsCore({ videoFields: createLiveStreamVideoFields() });
  const supervisor = createStreamSupervisorCore();
  const settings = createLiveStreamsSettingsCore();
  const videoSettings = createStreamVideoSettingsCore();
  return {
    async overview(channelId) {
      const [view, module, running, events, preview, youtube, entries, peers, video, lastApply, languages] = await Promise.all([
        rotation.getOverview(channelId),
        settings.get(),
        supervisor.runningHelper(channelId),
        listLiveStreamEvents(channelId, 50),
        broadcasts.previewStart(channelId).catch(() => null),
        supervisor.lastYoutubePoll(channelId),
        collectLiveStreamEntries(),
        listPeerLiveStreams().catch(() => []),
        videoSettings.get(channelId),
        latestLiveStreamEvent(channelId, "video_settings_applied"),
        getChannelExpectedLanguages(channelId),
      ]);
      return {
        ...view,
        // BL-186: null = never saved; a stored value that fails the schema is reported, never replaced by defaults.
        videoSettings: video.ok ? video.settings : null,
        videoSettingsProblem: video.ok ? null : video.problem,
        // BL-186 stage 3: the last video settings summary, read on its own (a 24/7 stream pushes it out of the 50 events).
        // Owner msg 3153: the broadcast's title/description language is the channel's baseline (shown read-only in the form).
        channelDefaultLanguage: languages.defaultLanguage,
        videoSettingsLast: lastApply ? { at: lastApply.at.toISOString(), detail: JSON.parse(lastApply.detailJson) as unknown } : null,
        module,
        // §3.10: the state in the one vocabulary the report and the Operator use.
        state: entries.find((e) => e.channelId === channelId)?.state ?? "off",
        // §3.11: the same channel's stream as other computers report it (read-only here).
        peers: peers.flatMap((p) => p.streams.filter((st) => st.channelId === channelId).map((st) => ({ deviceId: p.deviceId, hostName: p.hostName, updatedAt: p.updatedAt, stream: st }))),
        encoder: { running: Boolean(running), status: running?.status ?? null },
        youtube,
        startPreview: preview,
        events: events.map((e) => ({ id: e.id, at: e.at.toISOString(), kind: e.kind, detail: JSON.parse(e.detailJson) as unknown })),
      };
    },
    saveSettings: (channelId, body) => rotation.saveSettings(channelId, body),
    saveVideoSettings: (channelId, body) => videoSettings.save(channelId, body),
    setThumbnail: (channelId, bytes) => videoSettings.setThumbnail(channelId, bytes),
    clearThumbnail: (channelId) => videoSettings.clearThumbnail(channelId),
    readThumbnail: (channelId) => videoSettings.readThumbnail(channelId),
    addVideo: (channelId, body) => rotation.addVideo(channelId, body),
    addVideos: (channelId, body) => rotation.addVideos(channelId, body),
    listCandidates: (channelId, options) => createRotationPickerCore().listCandidates(channelId, options),
    removeVideo: (channelId, videoId) => rotation.removeVideo(channelId, { videoId }),
    reorder: (channelId, body) => rotation.reorder(channelId, body),
    overrideGuard: (channelId, videoId, body) => rotation.overrideGuard(channelId, { ...objectBody(body), videoId }),
    clearGuardOverride: (channelId, videoId) => rotation.clearGuardOverride(channelId, { videoId }),
    previewStart: (channelId) => broadcasts.previewStart(channelId),
    start: (channelId, credentialRef) => broadcasts.start(channelId, credentialRef),
    goLive: (channelId, credentialRef) => broadcasts.goLive(channelId, credentialRef),
    stop: (channelId, credentialRef, body) => broadcasts.stop(channelId, credentialRef, { encoderOnly: objectBody(body).encoderOnly === true }),
    // §3.9 Restart: the encoder only, on the same broadcast, with the rotation as it is now -- no YouTube write.
    restart: async (channelId) => ({ restarted: true, ...(await supervisor.restart(channelId)) }),
    // The module validates both strictly (a missing or malformed field is a 400, never a YouTube call).
    previewEdit: (channelId, credentialRef, body) => broadcasts.previewEdit(channelId, credentialRef, objectBody(body).patch),
    edit: (channelId, credentialRef, body) => broadcasts.edit(channelId, credentialRef, objectBody(body).patch, objectBody(body).expected),
    previewApplyVideoSettings: (channelId) => broadcasts.previewApplyVideoSettings(channelId),
    applyVideoSettings: (channelId, credentialRef) => broadcasts.applyVideoSettingsAgain(channelId, credentialRef),
  };
}

export function defaultLiveStreamRouteDeps(): LiveStreamRouteDeps {
  const channelAccess = createChannelAccessCore();
  return {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await channelAccess.assertActiveChannel(args);
    },
    // Resolved on first use, so importing a route never builds the cores.
    get core() {
      return createLiveStreamRouteCore();
    },
  };
}

export type RouteContext = { params: Promise<Record<string, string>> };

export function liveStreamHandler(
  deps: LiveStreamRouteDeps,
  run: (args: { core: LiveStreamRouteCore; channelId: string; params: Record<string, string>; userId: string; request: Request }) => Promise<NextResponse>
) {
  return async function handler(request: Request, context: RouteContext): Promise<NextResponse> {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const params = await context.params;
      const channelId = params.channelId;
      await deps.assertActiveChannel({ userId, channelId });
      return await run({ core: deps.core, channelId, params, userId, request });
    } catch (error) {
      if (isDomainError(error)) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export async function readJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 }) };
  }
}
