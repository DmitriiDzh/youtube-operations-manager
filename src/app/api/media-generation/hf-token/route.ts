import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../shared";

// BL-134 (FO-REQ-0028, ADR 0042): Settings → Cloud APIs → Hugging Face. The ONLY way the HF read token enters this app; it
// leaves only as its state and the Hugging Face user name (never the token).

export function createHfTokenGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json(await core.getHfToken()));
}

export function createHfTokenPutHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.setHfToken(body.body));
  });
}

export function createHfTokenDeleteHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json(await core.clearHfToken()));
}

export const GET = createHfTokenGetHandler();
export const PUT = createHfTokenPutHandler();
export const DELETE = createHfTokenDeleteHandler();
