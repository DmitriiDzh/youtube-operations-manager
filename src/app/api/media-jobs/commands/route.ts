import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { issueMediaJobCommand, listMediaJobCommands, type CommandView } from "@/lib/media-jobs-pool";
import { isDomainError } from "@/lib/shared-domain";

// BL-188 stage 2 (SHARED_MEDIA_JOBS_PLAN.md §2.3): the owner's actions on ANOTHER computer's media jobs and sessions -- cancel a
// job, run a job on its running session, approve or reject its session request. Session required (401). A job or a run is
// checked against the session's ACTIVE channel, resolved here and never taken from the request (ADR 0004 (b)); the target must be
// in that computer's own report. The command is only sent: that computer applies it with its own checks and limits, and its
// answer comes back in its report (GET lists the commands with their answers). Mutating methods pass `src/proxy.ts`'s gate.

export type MediaJobCommandsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  activeChannelOf: (userId: string) => Promise<string | null>;
  issue: (input: { raw: unknown; activeChannelId: string | null }) => Promise<CommandView>;
  list: () => Promise<CommandView[]>;
};

const defaultDeps = (): MediaJobCommandsRouteDeps => ({
  getSession: () => getServerSession(authOptions),
  activeChannelOf: (userId) => createChannelAccessCore().getActiveChannelId(userId),
  issue: (input) => issueMediaJobCommand(input),
  list: () => listMediaJobCommands(),
});

function errorResponse(error: unknown) {
  if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

export function createMediaJobCommandsHandlers(deps: MediaJobCommandsRouteDeps = defaultDeps()) {
  return {
    async GET() {
      const session = await deps.getSession();
      if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        return NextResponse.json({ commands: await deps.list() });
      } catch (error) {
        return errorResponse(error);
      }
    },
    async POST(request: Request) {
      const session = await deps.getSession();
      if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
      }
      try {
        const activeChannelId = await deps.activeChannelOf(session.user.id);
        return NextResponse.json({ command: await deps.issue({ raw, activeChannelId }) }, { status: 202 });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = createMediaJobCommandsHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
