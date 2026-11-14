import { NextResponse } from "next/server";
import { DomainError } from "@/lib/cross-posting";
import { defaultSocialRouteDeps, socialHandler, type SocialRouteDeps } from "../shared";

// BL-252 stage 2 (AC-XP-16): a channel's posts in the last 24 h against each network's limit (Instagram as Meta counts it).
export function createQuotaHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => {
    const channelId = new URL(request.url).searchParams.get("channelId")?.trim();
    if (!channelId) throw new DomainError({ code: "validation_failed", message: "channelId is required" });
    return NextResponse.json(await core.quota(channelId));
  });
}

export const GET = createQuotaHandler();
