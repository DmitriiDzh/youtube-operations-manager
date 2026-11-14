import { NextResponse } from "next/server";
import { defaultSocialRouteDeps, readJsonBody, socialHandler, type SocialRouteDeps } from "../shared";

// BL-252 stage 2: this computer's switch «Публикация в соцсети» (off by default). Turning it on or off is the owner's, on the Mac
// only (proxy REMOTE_BLOCKED_PREFIXES) -- like Live writes for YouTube; its state is part of GET /api/social.
export function createPostingPutHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => NextResponse.json(await core.setPostingSettings(await readJsonBody(request))));
}

export const PUT = createPostingPutHandler();
