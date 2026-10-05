import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../shared";

export function createSettingsGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json(await core.getSettings()));
}

/** Partial update; GPU/datacenter/volume values are checked against the live RunPod catalog (AC-P14-19). */
export function createSettingsPutHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.updateSettings(body.body));
  });
}

export const GET = createSettingsGetHandler();
export const PUT = createSettingsPutHandler();
