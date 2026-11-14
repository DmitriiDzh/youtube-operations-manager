import { NextResponse } from "next/server";
import { META_CALLBACK_PATH, defaultSocialRouteDeps, socialHandler, type SocialRouteDeps } from "./shared";

// BL-252: the card's state -- the Meta app (App ID only), the connected accounts (no tokens) and the two redirect URIs to enter
// in the Meta app. `?channelId=` narrows the accounts to one channel.
export function createSocialGetHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return socialHandler(deps, async ({ core, request }) => {
    const channelId = new URL(request.url).searchParams.get("channelId");
    const [metaApp, accounts] = await Promise.all([core.getMetaApp(), core.listAccounts(channelId && channelId.trim() ? channelId.trim() : null)]);
    return NextResponse.json({ metaApp, accounts, callbackPath: META_CALLBACK_PATH });
  });
}

export const GET = createSocialGetHandler();
