import { NextResponse } from "next/server";
import { defaultElevenlabsRouteDeps, elevenlabsHandler, readJsonBody, type ElevenlabsRouteDeps } from "../shared";

// BL-236: the ONLY way the ElevenLabs key enters this app (checked with ElevenLabs first); it leaves only as its last 4 characters.
export function createElevenlabsKeyPutHandler(deps: ElevenlabsRouteDeps = defaultElevenlabsRouteDeps()) {
  return elevenlabsHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.setKey(body.body));
  });
}

export function createElevenlabsKeyDeleteHandler(deps: ElevenlabsRouteDeps = defaultElevenlabsRouteDeps()) {
  return elevenlabsHandler(deps, async ({ core }) => NextResponse.json(await core.clearKey()));
}

export const PUT = createElevenlabsKeyPutHandler();
export const DELETE = createElevenlabsKeyDeleteHandler();
