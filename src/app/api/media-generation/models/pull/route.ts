import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../../shared";

/** Starts a model pull: a CPU pod attached to the volume downloads one Hugging Face file into models/<folder>/ (billed per second until it finishes). */
export function createModelPullPostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json({ pull: await core.startPull(body.body) }, { status: 201 });
  });
}

export const POST = createModelPullPostHandler();
