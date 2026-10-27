import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { isDomainError } from "@/lib/shared-domain";
import { cancelTranslationRequest } from "@/lib/localization-review";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type Deps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  channelAccess: Pick<ReturnType<typeof createChannelAccessCore>, "assertActiveChannel">;
  cancel: typeof cancelTranslationRequest;
};

/** BL-227 stage 2: the owner withdraws a translation request that is not finished (a request of another channel: not_found). */
export function createCancelRequestHandler(deps: Deps = { getSession: () => getServerSession(authOptions), channelAccess: createChannelAccessCore(), cancel: cancelTranslationRequest }) {
  return async function POST(_request: Request, { params }: { params: Promise<{ channelId: string; requestId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId, requestId } = await params;
      await deps.channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
      return NextResponse.json({ request: await deps.cancel(channelId, requestId) });
    } catch (error) {
      if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const POST = createCancelRequestHandler();
