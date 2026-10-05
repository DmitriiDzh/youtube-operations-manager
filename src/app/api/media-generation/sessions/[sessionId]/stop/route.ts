import { NextResponse } from "next/server";
import { bodyRecord, defaultMediaRouteDeps, mediaParamsHandler, readJsonBody, type MediaRouteDeps } from "../../../shared";

/** Web-UI ONLY (fenced): terminate the session's pod now and confirm it is gone. */
export function createSessionStopHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaParamsHandler<{ sessionId: string }>(deps, async ({ core, request, params }) => {
    const body = await readJsonBody(request).catch(() => ({ ok: true as const, body: {} }));
    const reason = body.ok ? bodyRecord(body.body).reason : undefined;
    return NextResponse.json({ session: await core.stopSession({ sessionId: params.sessionId, ...(typeof reason === "string" ? { reason } : {}) }) });
  });
}

export const POST = createSessionStopHandler();
