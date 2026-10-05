import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../shared";

// Settings → Media → Credentials. The ONLY way RunPod / S3 keys enter this app (owner instruction,
// Telegram 2026-10-05); they leave only as the public status (prefix, S3 key id, verifiedAt).

export function createCredentialsGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json(await core.getCredentialsStatus()));
}

export function createCredentialsPutHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.setCredentials(body.body));
  });
}

export function createCredentialsDeleteHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json(await core.clearCredentials()));
}

export const GET = createCredentialsGetHandler();
export const PUT = createCredentialsPutHandler();
export const DELETE = createCredentialsDeleteHandler();
