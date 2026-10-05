import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMediaGenerationCore, type MediaGenerationCore } from "@/lib/media-generation";
import { mediaErrorResponse, readJsonBody } from "../../../shared";

type Deps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<MediaGenerationCore, "rejectSession">;
};

/** Web-UI ONLY (fenced): a pending request is declined with a reason. */
export function createSessionRejectHandlers(deps: Deps = { getSession: () => getServerSession(authOptions), core: createMediaGenerationCore() }) {
  return {
    async POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
      const session = await deps.getSession();
      if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        const { sessionId } = await params;
        const body = await readJsonBody(request);
        if (!body.ok) return body.response;
        const reason = body.body && typeof body.body === "object" ? (body.body as { reason?: unknown }).reason : undefined;
        const result = await deps.core.rejectSession({ sessionId, reason });
        return NextResponse.json({ session: result });
      } catch (error) {
        return mediaErrorResponse(error);
      }
    },
  };
}

export const POST = createSessionRejectHandlers().POST;
