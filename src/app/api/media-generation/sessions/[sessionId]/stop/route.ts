import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createMediaGenerationCore, type MediaGenerationCore } from "@/lib/media-generation";
import { mediaErrorResponse, readJsonBody } from "../../../shared";

type Deps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<MediaGenerationCore, "stopSession">;
};

/** Web-UI ONLY (fenced): terminate the session's pod now and confirm it is gone. */
export function createSessionStopHandlers(deps: Deps = { getSession: () => getServerSession(authOptions), core: createMediaGenerationCore() }) {
  return {
    async POST(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
      const session = await deps.getSession();
      if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        const { sessionId } = await params;
        const body = await readJsonBody(request).catch(() => ({ ok: true as const, body: {} }));
        const reason = body.ok && body.body && typeof body.body === "object" ? (body.body as { reason?: unknown }).reason : undefined;
        const result = await deps.core.stopSession({ sessionId, ...(typeof reason === "string" ? { reason } : {}) });
        return NextResponse.json({ session: result });
      } catch (error) {
        return mediaErrorResponse(error);
      }
    },
  };
}

export const POST = createSessionStopHandlers().POST;
