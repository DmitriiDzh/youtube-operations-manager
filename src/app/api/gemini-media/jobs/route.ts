import { NextResponse } from "next/server";
import { createChannelAccessCore } from "@/lib/channel-access";
import { geminiHandler, readJsonBody, defaultGeminiRouteDeps, type GeminiRouteDeps } from "../shared";

// BL-188 stage 4 (SHARED_MEDIA_JOBS_PLAN.md §5 item 4, owner msg 2806 Q3): the owner's own Gemini job from Media, on THIS
// computer -- the same create the Factory Operator's tool runs (switch, key, model rules, inputs, storyboard gate, this
// computer's limits), recorded as the owner's. `dryRun: true` only answers the estimate and whether it fits. The channel is the
// session's ACTIVE channel, resolved here and never taken from the request (ADR 0004 (b)); a body naming a channel is refused.
// A job on another computer goes through /api/media-jobs/commands instead. Session required (401); POST passes `src/proxy.ts`'s
// device-availability gate like every mutating /api route.

export type GeminiJobsRouteDeps = GeminiRouteDeps & { activeChannelOf: (userId: string) => Promise<string | null> };

export function createGeminiJobsPostHandler(
  deps: GeminiJobsRouteDeps = Object.assign(defaultGeminiRouteDeps(), { activeChannelOf: (userId: string) => createChannelAccessCore().getActiveChannelId(userId) })
) {
  return async function POST(request: Request): Promise<NextResponse> {
    const session = await deps.getSession();
    const userId = session?.user?.id ?? null;
    return geminiHandler(deps, async ({ core }) => {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      if (!body.body || typeof body.body !== "object" || Array.isArray(body.body)) {
        return NextResponse.json({ error: "validation_failed", message: "The request must be an object." }, { status: 400 });
      }
      if ("channelId" in body.body) {
        return NextResponse.json({ error: "validation_failed", message: "The channel is the active one; do not send channelId." }, { status: 400 });
      }
      const channelId = userId ? await deps.activeChannelOf(userId) : null;
      if (!channelId) return NextResponse.json({ error: "validation_failed", message: "Choose a channel first: a Gemini job is made for the active channel." }, { status: 400 });
      const result = await core.createJob({ ...(body.body as Record<string, unknown>), channelId }, "owner");
      return NextResponse.json(result, { status: "dryRun" in result ? 200 : 201 });
    })(request);
  };
}

export const POST = createGeminiJobsPostHandler();
