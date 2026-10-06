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

/** Grows a network volume (`{ volumeId, sizeGb }`; RunPod never shrinks one) -- an explicit operator action that raises the monthly bill. */
export function createNetworkVolumesPatchHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json({ volume: await core.resizeNetworkVolume(body.body) });
  });
}

/** BL-136: permanently deletes a network volume that is not the configured one and not mounted by any pod (`{ volumeId }`). */
export function createNetworkVolumesDeleteHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.deleteUnusedNetworkVolume(body.body));
  });
}

export const GET = createNetworkVolumesGetHandler();
export const POST = createNetworkVolumesPostHandler();
export const PATCH = createNetworkVolumesPatchHandler();
export const DELETE = createNetworkVolumesDeleteHandler();
