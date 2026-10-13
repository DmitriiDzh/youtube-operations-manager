import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { isPublishingSettingField } from "@/lib/publishing";
import { createChannelPublishingSettingsCoreForProduction, DomainError, type ChannelPublishingSettingsCore } from "@/lib/sync-gateway";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type RouteContext = { params: Promise<{ channelId: string }> };

export type PublishingSettingsConflictsDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<unknown>;
  core: () => Pick<ChannelPublishingSettingsCore, "listConflicts" | "resolveConflict">;
};

function defaultDeps(): PublishingSettingsConflictsDeps {
  const channelAccess = createChannelAccessCore();
  return {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: (args) => channelAccess.assertActiveChannel(args),
    core: () => createChannelPublishingSettingsCoreForProduction(),
  };
}

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

/**
 * BL-182 stage 2: the channel's publishing defaults set differently on the computers. GET is read-only: each conflict names one
 * writer per distinct value. POST keeps one computer's value (`winningActorId`); the value is re-derived from the document, never
 * taken from the request, and becomes the value on every computer at the next sync. The active channel only (ADR 0004), like
 * the language-settings conflicts route.
 */
export function createPublishingSettingsConflictsHandlers(deps: PublishingSettingsConflictsDeps = defaultDeps()) {
  return {
    async GET(_request: Request, { params }: RouteContext): Promise<NextResponse> {
      const session = await deps.getSession();
      if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        const { channelId } = await params;
        await deps.assertActiveChannel({ userId: session.user.id, channelId });
        return NextResponse.json({ conflicts: await deps.core().listConflicts(channelId) });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
      const session = await deps.getSession();
      if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        const { channelId } = await params;
        await deps.assertActiveChannel({ userId: session.user.id, channelId });
        const body: unknown = await request.json().catch(() => null);
        const { field, winningActorId } = (body ?? {}) as { field?: unknown; winningActorId?: unknown };
        if (typeof field !== "string" || !isPublishingSettingField(field) || typeof winningActorId !== "string") {
          return NextResponse.json({ error: "validation_failed", message: "field (a publishing setting) and winningActorId are required" }, { status: 400 });
        }
        await deps.core().resolveConflict({ channelId, field, winningActorId });
        return NextResponse.json({ ok: true });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = createPublishingSettingsConflictsHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
