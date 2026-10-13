import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createPublishingSettingsCore, parsePublishingSettingsPatch, type PublishingSettingsService } from "@/lib/publishing";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type RouteContext = { params: Promise<{ channelId: string }> };

export type PublishingSettingsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<unknown>;
  service: () => Pick<PublishingSettingsService, "read" | "save">;
};

function defaultDeps(): PublishingSettingsRouteDeps {
  const channelAccess = createChannelAccessCore();
  return {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: (args) => channelAccess.assertActiveChannel(args),
    service: () => createPublishingSettingsCore(),
  };
}

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

/**
 * BL-182 stage 2 (PUBLISHING_PLAN.md §2 stage 2 item 2; owner msg 2715): the channel's publishing defaults. GET returns the
 * values in force (saved or default), which fields were saved, and the fields set differently on the two computers. PUT saves
 * the fields the owner changed -- each validated, nothing saved when one is not. Local only (no YouTube call); the active
 * channel only (ADR 0004), like the language settings.
 */
export function createPublishingSettingsHandlers(deps: PublishingSettingsRouteDeps = defaultDeps()) {
  return {
    async GET(_request: Request, { params }: RouteContext): Promise<NextResponse> {
      const session = await deps.getSession();
      if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        const { channelId } = await params;
        await deps.assertActiveChannel({ userId: session.user.id, channelId });
        return NextResponse.json(await deps.service().read(channelId));
      } catch (error) {
        return errorResponse(error);
      }
    },

    async PUT(request: Request, { params }: RouteContext): Promise<NextResponse> {
      const session = await deps.getSession();
      if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        const { channelId } = await params;
        await deps.assertActiveChannel({ userId: session.user.id, channelId });
        const parsed = parsePublishingSettingsPatch(await request.json().catch(() => null));
        if (!parsed.ok) return NextResponse.json({ error: "validation_failed", message: parsed.message }, { status: 400 });
        return NextResponse.json(await deps.service().save(channelId, parsed.patch));
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = createPublishingSettingsHandlers();
export const GET = handlers.GET;
export const PUT = handlers.PUT;
