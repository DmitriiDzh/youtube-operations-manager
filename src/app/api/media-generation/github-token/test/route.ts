import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, type MediaRouteDeps } from "../../shared";

// BL-230: one `GET /user` with the stored GitHub token; answers the view (never the token).
export function createGithubTokenTestHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json(await core.testGithubToken()));
}

export const POST = createGithubTokenTestHandler();
