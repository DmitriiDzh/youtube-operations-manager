import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../../../shared";

// BL-138 (owner, Telegram 2026-10-06, msg 1739): Stop a session another device started (`{ deviceId, sessionId }`) -- its pod is
// terminated through RunPod directly; refused for another RunPod account and for a pod that is not that session's own.

export function createSessionDevicesStopPostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.stopOtherDeviceSession(body.body));
  });
}

export const POST = createSessionDevicesStopPostHandler();
