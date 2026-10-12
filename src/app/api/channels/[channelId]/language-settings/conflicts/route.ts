import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelLanguageSettingsCoreForProduction, DomainError, LANGUAGE_SETTING_FIELDS, type LanguageSettingField } from "@/lib/sync-gateway";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const channelAccess = createChannelAccessCore();

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

/**
 * BL-178 part B: the channel's language settings set differently on the computers -- read-only. Each conflict names one writer
 * per distinct value and this computer's own value (kept here until the owner chooses). Mirrors the editorial-profile route.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { channelId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    return NextResponse.json({ conflicts: await createChannelLanguageSettingsCoreForProduction().listConflicts(channelId) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * The owner keeps one computer's value of a conflicted setting (`winningActorId`); the value itself is re-derived from the
 * document, never taken from the request. It becomes the value on every computer at the next sync.
 */
export async function POST(request: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { channelId } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    const body: unknown = await request.json().catch(() => null);
    const { field, winningActorId } = (body ?? {}) as { field?: unknown; winningActorId?: unknown };
    if (typeof field !== "string" || !(LANGUAGE_SETTING_FIELDS as readonly string[]).includes(field) || typeof winningActorId !== "string") {
      return NextResponse.json({ error: "validation_failed", message: `field (one of ${LANGUAGE_SETTING_FIELDS.join(", ")}) and winningActorId are required` }, { status: 400 });
    }
    const settings = await createChannelLanguageSettingsCoreForProduction().resolveConflict({ channelId, field: field as LanguageSettingField, winningActorId });
    return NextResponse.json({ settings });
  } catch (error) {
    return errorResponse(error);
  }
}
