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

// 2026-11-15: the Facebook Login for Business configuration id (not a secret; the stored App Secret is kept). Mac-only like PUT.
export function createMetaAppPatchHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => NextResponse.json(await core.setMetaConfig(await readJsonBody(request))));
}

export const PUT = createMetaAppPutHandler();
export const PATCH = createMetaAppPatchHandler();
export const DELETE = createMetaAppDeleteHandler();
