import { NextResponse } from "next/server";
import { defaultSocialRouteDeps, readJsonBody, socialHandler, type SocialRouteDeps } from "../../shared";

// BL-252 stage 2: the owner's retry of a failed job that never sent its publishing call (owner TG 4780). It only marks the job; the
// runner posts it however late, never before its planned time, while the slot is still approved and the network's check passes, and
// clears the mark with its own code otherwise or after 48 h. Web session only; no MCP or agent path.
export function createRetryHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => NextResponse.json(await core.retryJob(await readJsonBody(request))));
}

export const POST = createRetryHandler();
