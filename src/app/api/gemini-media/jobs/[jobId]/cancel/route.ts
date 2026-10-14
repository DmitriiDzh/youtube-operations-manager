import { NextResponse } from "next/server";
import { createChannelAccessCore } from "@/lib/channel-access";
import { DomainError } from "@/lib/gemini-media";
import { defaultGeminiRouteDeps, geminiHandler, type GeminiRouteDeps } from "../../../shared";

// BL-188 stage 2 (SHARED_MEDIA_JOBS_PLAN.md §2.5): the owner cancels one of THIS computer's Gemini jobs before it is sent to
// Google (Media's shared list; another computer's job goes through /api/media-jobs/commands instead). Session required (401);
// a job already sent or finished answers 409 `gemini_cancel_too_late`, an unknown one 404. Only a job of the session's ACTIVE
// channel (resolved here, never from the request: ADR 0004 (b), independent review) -- another channel's job answers
// `CHANNEL_NOT_AUTHORIZED` and is left as it is.

export type GeminiJobCancelRouteDeps = GeminiRouteDeps & { activeChannelOf: (userId: string) => Promise<string | null> };

export function createGeminiJobCancelHandler(
  deps: GeminiJobCancelRouteDeps = Object.assign(defaultGeminiRouteDeps(), { activeChannelOf: (userId: string) => createChannelAccessCore().getActiveChannelId(userId) })
) {
  return async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
    const { jobId } = await context.params;
    const session = await deps.getSession();
    const userId = session?.user?.id ?? null;
    return geminiHandler(deps, async ({ core }) => {
      const activeChannelId = userId ? await deps.activeChannelOf(userId) : null;
      const found = await core.getJobs({ jobId });
      const job = "job" in found ? found.job : null;
      if (!job) throw new DomainError({ code: "gemini_job_not_found", message: `No Gemini job ${jobId} on this computer.`, details: { jobId } });
      if (!activeChannelId || job.channelId !== activeChannelId) {
        throw new DomainError({ code: "CHANNEL_NOT_AUTHORIZED", message: "The job belongs to another channel than the active one.", details: { jobId } });
      }
      return NextResponse.json(await core.cancelJob(jobId));
    })(request);
  };
}

export const POST = createGeminiJobCancelHandler();
