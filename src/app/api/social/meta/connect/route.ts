import { NextResponse } from "next/server";
import { defaultSocialRouteDeps, readJsonBody, redirectUriFor, socialHandler, type SocialRouteDeps } from "../../shared";

// BL-252: starts connecting a channel's Facebook Page + Instagram -- returns Meta's consent URL for the browser to open.
export function createMetaConnectHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => NextResponse.json(await core.startConnect(await readJsonBody(request), redirectUriFor(request.headers))));
}

export const POST = createMetaConnectHandler();
