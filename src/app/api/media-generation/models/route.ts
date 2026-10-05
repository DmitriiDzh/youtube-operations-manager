import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../shared";

// Phase 14 slice 4 (owner decision D5, "Models" panel): what is on the volume under models/ (one S3
// listing) plus the recorded pulls. A GET is read-only (review round 6): the server's watch loop in
// src/instrumentation.ts is what advances a pull (polls the volume, terminates the finished pull's CPU
// pod) -- a read verb never terminates pods or rewrites state, so it stays outside the device mutation
// gate by right, not by accident. DELETE removes one model object (explicit operator action).

export function createModelsGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => {
    const [pulls, models] = await Promise.all([core.listPulls(), core.listModels()]);
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
