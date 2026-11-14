import { NextResponse } from "next/server";
import { DomainError } from "@/lib/cross-posting";
import { defaultSocialRouteDeps, socialHandler, type SocialRouteDeps } from "../../shared";

// BL-252 stage 2 (AC-XP-8): the identity read of a channel's connected Meta accounts -- Meta's live answer (token valid, scopes,
// the Page and Instagram it reaches) against what is stored. Read-only, no token in the answer.
export function createMetaCheckHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => {
    const channelId = new URL(request.url).searchParams.get("channelId")?.trim();
    if (!channelId) throw new DomainError({ code: "validation_failed", message: "channelId is required" });
    return NextResponse.json(await core.checkAccounts(channelId));
  });
}

export const GET = createMetaCheckHandler();
