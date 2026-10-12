import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import {
  createChannelLanguageSettingsCoreForProduction,
  DomainError,
  LANGUAGE_SETTING_FIELDS,
  type ChannelLanguageSettingsCore,
  type LanguageSettingField,
} from "@/lib/sync-gateway";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type RouteContext = { params: Promise<{ channelId: string }> };

export type LanguageSettingsConflictsDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<unknown>;
  core: () => Pick<ChannelLanguageSettingsCore, "listConflicts" | "resolveConflict">;
};

function defaultDeps(): LanguageSettingsConflictsDeps {
  const channelAccess = createChannelAccessCore();
  return {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: (args) => channelAccess.assertActiveChannel(args),
    core: () => createChannelLanguageSettingsCoreForProduction(),
  };
}

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

/**
 * BL-178 part B: the channel's language settings set differently on the computers. GET is read-only: each conflict names one
 * writer per distinct value and this computer's own value (kept here until the owner chooses). POST keeps one computer's value
 * (`winningActorId`); the value itself is re-derived from the document, never taken from the request, and becomes the value
 * on every computer at the next sync. The active channel only (ADR 0004), like the editorial-profile route.
 */
export function createLanguageSettingsConflictsHandlers(deps: LanguageSettingsConflictsDeps = defaultDeps()) {
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
        if (typeof field !== "string" || !(LANGUAGE_SETTING_FIELDS as readonly string[]).includes(field) || typeof winningActorId !== "string") {
          return NextResponse.json({ error: "validation_failed", message: `field (one of ${LANGUAGE_SETTING_FIELDS.join(", ")}) and winningActorId are required` }, { status: 400 });
        }
        const settings = await deps.core().resolveConflict({ channelId, field: field as LanguageSettingField, winningActorId });
        return NextResponse.json({ settings });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = createLanguageSettingsConflictsHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
