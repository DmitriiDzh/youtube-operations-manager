import { NextResponse } from "next/server";
import { defaultGeminiRouteDeps, geminiHandler, type GeminiRouteDeps } from "../../../shared";

// BL-188 stage 2 (SHARED_MEDIA_JOBS_PLAN.md §2.5): the owner cancels one of THIS computer's Gemini jobs before it is sent to
// Google (Media's shared list; another computer's job goes through /api/media-jobs/commands instead). Session required (401);
// a job already sent or finished answers 409 `gemini_cancel_too_late`, an unknown one 404.
export function createGeminiJobCancelHandler(deps: GeminiRouteDeps = defaultGeminiRouteDeps()) {
  return async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
    const { jobId } = await context.params;
    return geminiHandler(deps, async ({ core }) => NextResponse.json(await core.cancelJob(jobId)))(request);
  };
}

export const POST = createGeminiJobCancelHandler();
