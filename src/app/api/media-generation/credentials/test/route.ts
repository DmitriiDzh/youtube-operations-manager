import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, type MediaRouteDeps } from "../../shared";

/** One real RunPod read (and one S3 listing when configured) -- an explicit operator action, never automatic. */
export function createCredentialsTestPostHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json(await core.testCredentials()));
}

export const POST = createCredentialsTestPostHandler();
