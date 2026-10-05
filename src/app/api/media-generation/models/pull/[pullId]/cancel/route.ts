import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMediaGenerationCore, type MediaGenerationCore } from "@/lib/media-generation";
import { mediaErrorResponse } from "../../../../shared";

type Deps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<MediaGenerationCore, "cancelPull">;
};

export function createModelPullCancelHandler(deps: Deps = { getSession: () => getServerSession(authOptions), core: createMediaGenerationCore() }) {
  return async function POST(_request: Request, { params }: { params: Promise<{ pullId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { pullId } = await params;
      return NextResponse.json({ pull: await deps.core.cancelPull({ pullId }) });
    } catch (error) {
      return mediaErrorResponse(error);
    }
  };
}

export const POST = createModelPullCancelHandler();
