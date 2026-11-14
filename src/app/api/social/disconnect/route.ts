import { NextResponse } from "next/server";
import { defaultSocialRouteDeps, readJsonBody, socialHandler, type SocialRouteDeps } from "../shared";

// BL-252: forgets a channel's connected account(s) on this computer (the stored token goes with it). Mac-only.
export function createSocialDisconnectHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => NextResponse.json(await core.disconnect(await readJsonBody(request))));
}

export const POST = createSocialDisconnectHandler();
