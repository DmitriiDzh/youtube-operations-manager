import { NextResponse } from "next/server";
import { defaultVidiqRouteDeps, readJsonBody, vidiqHandler, type VidiqRouteDeps } from "../shared";

// BL-278 (ADR 0077 decision 3): the ONLY way the vidIQ key enters this app -- checked with vidIQ's free balance read first, then
// stored in the device-secret slot `vidiq`; it leaves only as its last 4 characters. Mac only (src/proxy.ts).
export function createVidiqKeyPutHandler(deps: VidiqRouteDeps = defaultVidiqRouteDeps()) {
  return vidiqHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.saveKey(body.body));
  });
}

export function createVidiqKeyDeleteHandler(deps: VidiqRouteDeps = defaultVidiqRouteDeps()) {
  return vidiqHandler(deps, async ({ core }) => NextResponse.json(await core.clearKey()));
}

export const PUT = createVidiqKeyPutHandler();
export const DELETE = createVidiqKeyDeleteHandler();
