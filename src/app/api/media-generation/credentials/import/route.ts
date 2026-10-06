import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../../shared";

// BL-137: imports an exported credentials file (`{ file, password }`); returns the public credentials status, like PUT.

export function createCredentialsImportPostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.importCredentials(body.body));
  });
}

export const POST = createCredentialsImportPostHandler();
