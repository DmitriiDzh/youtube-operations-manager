import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMediaGenerationCore, type MediaGenerationCore } from "@/lib/media-generation";
import { mediaErrorResponse } from "../../../shared";

type Deps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<MediaGenerationCore, "cancelJob">;
};

export function createJobCancelHandler(deps: Deps = { getSession: () => getServerSession(authOptions), core: createMediaGenerationCore() }) {
  return async function POST(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { jobId } = await params;
      return NextResponse.json({ job: await deps.core.cancelJob({ jobId }) });
    } catch (error) {
      return mediaErrorResponse(error);
    }
  };
}

export const POST = createJobCancelHandler();
