import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, readJsonBody, type MediaRouteDeps } from "../shared";

// BL-230 (ADR 0043 amendment 1): Settings → Cloud APIs → GitHub. The ONLY way the GitHub read token enters this app; it leaves
// only as its state, the GitHub login, its expiry and the check times (never the token). Session required (`mediaHandler`).

export function createGithubTokenGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json(await core.getGithubToken()));
}

export function createGithubTokenPutHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.setGithubToken(body.body));
  });
}

export function createGithubTokenDeleteHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json(await core.clearGithubToken()));
}

export const GET = createGithubTokenGetHandler();
export const PUT = createGithubTokenPutHandler();
export const DELETE = createGithubTokenDeleteHandler();
