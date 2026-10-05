import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../shared";

// Phase 14 slice 4 (owner decision D5, "Models" panel): what is on the volume under models/ (one S3
// listing) plus the pulls in flight -- each GET also advances the pulls (polls the volume, terminates a
// finished pull's CPU pod). DELETE removes one model object (explicit operator action).

export function createModelsGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => {
    const pulls = await core.pollPulls();
    const models = await core.listModels();
    return NextResponse.json({ models, pulls });
  });
}

export function createModelsDeleteHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.deleteModel(body.body));
  });
}

export const GET = createModelsGetHandler();
export const DELETE = createModelsDeleteHandler();
