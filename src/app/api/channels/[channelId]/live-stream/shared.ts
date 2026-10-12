import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { listLiveStreamEvents } from "@/lib/db";
import {
  createLiveBroadcastsCore,
  createLiveStreamsCore,
  createLiveStreamsSettingsCore,
  createStreamSupervisorCore,
  isDomainError,
} from "@/lib/live-streams";

// BL-176 (LIVE_STREAMS_PLAN.md §3.9/§3.12): the owner's routes for a channel's live stream. Every handler: a Web session
// (401), the channel must be the active one (ADR 0004, 403), a thin call into the module, DomainError -> status. Only
// start / go-live / stop / edit write to YouTube (through the module's gateway adapter, with Live writes and the identity
// check); no response ever carries the stream key. Mutating methods pass `src/proxy.ts`'s gate like every /api route.

export type LiveStreamRouteCore = {
  overview(channelId: string): Promise<unknown>;
  saveSettings(channelId: string, body: unknown): Promise<unknown>;
  addVideo(channelId: string, body: unknown): Promise<unknown>;
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
};

export type LiveStreamRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  core: LiveStreamRouteCore;
};

type Patch = { title?: string; description?: string; privacyStatus?: "public" | "unlisted" | "private" };

function objectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

export function createLiveStreamRouteCore(): LiveStreamRouteCore {
  const rotation = createLiveStreamsCore();
  const broadcasts = createLiveBroadcastsCore();
  const supervisor = createStreamSupervisorCore();
  const settings = createLiveStreamsSettingsCore();
  return {
    async overview(channelId) {
      const [view, module, running, events, preview, youtube] = await Promise.all([
        rotation.getOverview(channelId),
        settings.get(),
        supervisor.runningHelper(channelId),
        listLiveStreamEvents(channelId, 50),
        broadcasts.previewStart(channelId).catch(() => null),
        supervisor.lastYoutubePoll(channelId),
      ]);
      return {
        ...view,
        module,
        encoder: { running: Boolean(running), status: running?.status ?? null },
        youtube,
        startPreview: preview,
        events: events.map((e) => ({ id: e.id, at: e.at.toISOString(), kind: e.kind, detail: JSON.parse(e.detailJson) as unknown })),
      };
    },
    saveSettings: (channelId, body) => rotation.saveSettings(channelId, body),
    addVideo: (channelId, body) => rotation.addVideo(channelId, body),
    removeVideo: (channelId, videoId) => rotation.removeVideo(channelId, { videoId }),
    reorder: (channelId, body) => rotation.reorder(channelId, body),
    overrideGuard: (channelId, videoId, body) => rotation.overrideGuard(channelId, { ...objectBody(body), videoId }),
    clearGuardOverride: (channelId, videoId) => rotation.clearGuardOverride(channelId, { videoId }),
    previewStart: (channelId) => broadcasts.previewStart(channelId),
    start: (channelId, credentialRef) => broadcasts.start(channelId, credentialRef),
    goLive: (channelId, credentialRef) => broadcasts.goLive(channelId, credentialRef),
    stop: (channelId, credentialRef, body) => broadcasts.stop(channelId, credentialRef, { encoderOnly: objectBody(body).encoderOnly === true }),
    // §3.9 Restart: the encoder only, on the same broadcast -- no YouTube write. The background loop starts it again.
    restart: async (channelId) => ({ stopped: await supervisor.stopEncoder(channelId, "owner_restart") }),
    previewEdit: (channelId, credentialRef, body) => broadcasts.previewEdit(channelId, credentialRef, objectBody(body).patch as Patch),
    edit: (channelId, credentialRef, body) => {
      const b = objectBody(body);
      return broadcasts.edit(channelId, credentialRef, b.patch as Patch, b.expected as { title: string; description: string; privacyStatus: string });
    },
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
