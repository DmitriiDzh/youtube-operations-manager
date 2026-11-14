import { NextResponse } from "next/server";
import { defaultSocialRouteDeps, readJsonBody, socialHandler, type SocialRouteDeps } from "../../shared";

// BL-252: the owner's pick -- stores the Page (and its Instagram account) for the channel the connect was started for.
export function createMetaSelectHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => NextResponse.json({ accounts: await core.selectPage(await readJsonBody(request)) }));
}

export const POST = createMetaSelectHandler();
