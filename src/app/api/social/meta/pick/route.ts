import { NextResponse } from "next/server";
import { defaultSocialRouteDeps, socialHandler, type SocialRouteDeps } from "../../shared";

// BL-252: the Pages Meta returned after consent (names and linked Instagram accounts, no tokens), for the owner's pick.
export function createMetaPickHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => NextResponse.json(core.getPick(new URL(request.url).searchParams.get("id") ?? "")));
}

export const GET = createMetaPickHandler();
