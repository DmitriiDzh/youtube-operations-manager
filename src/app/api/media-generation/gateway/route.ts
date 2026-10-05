import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../shared";

/** The "Media gateway" toggle (every RunPod / S3 / ComfyUI call checks it). */
export function createGatewayPutHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    const enabled = (body.body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "validation_failed", message: "enabled must be a boolean" }, { status: 400 });
    }
    await core.setGatewayEnabled(enabled);
    return NextResponse.json({ enabled: await core.getGatewayEnabled() });
  });
}

export const PUT = createGatewayPutHandler();
