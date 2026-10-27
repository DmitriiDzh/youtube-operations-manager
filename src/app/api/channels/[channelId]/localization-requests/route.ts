import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { isDomainError } from "@/lib/shared-domain";
import { createTranslationRequest, listTranslationRequests } from "@/lib/localization-review";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type Deps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  channelAccess: Pick<ReturnType<typeof createChannelAccessCore>, "assertActiveChannel">;
  create: typeof createTranslationRequest;
  list: typeof listTranslationRequests;
};

const production = (): Deps => ({ getSession: () => getServerSession(authOptions), channelAccess: createChannelAccessCore(), create: createTranslationRequest, list: listTranslationRequests });

function failure(error: unknown) {
  if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

/** BL-227 stage 2 (LANGUAGES_REVIEW_PLAN.md §7a): the owner's translation requests of the active channel -- list them, or make one. */
export function createRequestsHandlers(deps: Deps = production()) {
  async function GET(_request: Request, { params }: { params: Promise<{ channelId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId } = await params;
      await deps.channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
      return NextResponse.json(await deps.list({ channelId }));
    } catch (error) {
      return failure(error);
    }
  }
  async function POST(request: Request, { params }: { params: Promise<{ channelId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId } = await params;
      await deps.channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
      const body = await request.json().catch(() => null);
      return NextResponse.json({ request: await deps.create(channelId, body) }, { status: 201 });
    } catch (error) {
      return failure(error);
    }
  }
  return { GET, POST };
}

const handlers = createRequestsHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
