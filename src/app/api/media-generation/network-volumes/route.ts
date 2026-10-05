import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../shared";

export function createNetworkVolumesGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json({ volumes: await core.listNetworkVolumes() }));
}

/** Creates a network volume (billed monthly by RunPod from this moment) -- an explicit operator action. */
export function createNetworkVolumesPostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json({ volume: await core.createNetworkVolume(body.body) }, { status: 201 });
  });
}

export const GET = createNetworkVolumesGetHandler();
export const POST = createNetworkVolumesPostHandler();
