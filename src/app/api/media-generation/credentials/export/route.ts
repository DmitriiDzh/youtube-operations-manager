import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../../shared";

// BL-137 (owner, Telegram 2026-10-06, msgs 1702-1704): this device's RunPod/S3 credentials as a file encrypted under a password
// the operator types (`{ password }` -> `{ file }`). The response carries only ciphertext and the public hints, never a key.

export function createCredentialsExportPostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.exportCredentials(body.body), { headers: { "cache-control": "no-store" } });
  });
}

export const POST = createCredentialsExportPostHandler();
