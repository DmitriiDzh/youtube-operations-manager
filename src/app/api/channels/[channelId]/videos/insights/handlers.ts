import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { isDomainError } from "@/lib/shared-domain";
import type { VideoInsightsResult } from "@/lib/video-insights";
import { getVideoMetadataErrorStatus } from "../../../../video-metadata/error-status";

// BL-221 (docs/roadmap/plans/CONTENT_UX_PLAN.md stage A): the «Видео» list's extras -- each video's kind and its last 7 days.
// A Web session and the ACTIVE channel (AGENTS.md §F, ADR 0004); a local read, never a YouTube call. Its own route: the list
// works without it.

export type VideoInsightsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  load: (channelId: string) => Promise<VideoInsightsResult>;
};

const defaultDeps = (): VideoInsightsRouteDeps => ({
  getSession: () => getServerSession(authOptions),
  assertActiveChannel: async (args) => {
    await createChannelAccessCore().assertActiveChannel(args);
  },
  load: async (channelId) => (await import("@/lib/video-insights")).loadVideoInsights(channelId),
});

export function createVideoInsightsHandler(deps: VideoInsightsRouteDeps = defaultDeps()) {
  return async (_request: Request, context: { params: Promise<{ channelId: string }> }): Promise<Response> => {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId } = await context.params;
      await deps.assertActiveChannel({ userId, channelId });
      return NextResponse.json(await deps.load(channelId));
    } catch (error) {
      if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}
