import { NextResponse } from "next/server";
import { defaultSocialRouteDeps, readJsonBody, socialHandler, type SocialRouteDeps } from "../../shared";

// BL-252 stage 2: the owner's retry of a failed job that never published (the runner starts it again if it is still due).
export function createRetryHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => NextResponse.json(await core.retryJob(await readJsonBody(request))));
}

export const POST = createRetryHandler();
