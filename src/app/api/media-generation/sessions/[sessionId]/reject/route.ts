import { NextResponse } from "next/server";
import { bodyRecord, defaultMediaRouteDeps, mediaParamsHandler, readJsonBody, type MediaRouteDeps } from "../../../shared";

/** Web-UI ONLY (fenced): a pending request is declined with a reason. */
export function createSessionRejectHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaParamsHandler<{ sessionId: string }>(deps, async ({ core, request, params }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json({ session: await core.rejectSession({ sessionId: params.sessionId, reason: bodyRecord(body.body).reason }) });
  });
}

export const POST = createSessionRejectHandler();
