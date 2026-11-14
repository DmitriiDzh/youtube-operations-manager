import { NextResponse } from "next/server";
import { defaultSocialRouteDeps, readJsonBody, socialHandler, type SocialRouteDeps } from "../../shared";

// BL-252: the ONLY way the Meta App Secret enters this app (device secret `meta_app`, sealed); it never leaves (only the App ID).
// Mac-only (proxy REMOTE_BLOCKED_PREFIXES), like every other cloud key.
export function createMetaAppPutHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => NextResponse.json(await core.setMetaApp(await readJsonBody(request))));
}

export function createMetaAppDeleteHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core }) => NextResponse.json(await core.clearMetaApp()));
}

export const PUT = createMetaAppPutHandler();
export const DELETE = createMetaAppDeleteHandler();
