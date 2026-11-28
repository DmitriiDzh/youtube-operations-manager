import { NextResponse } from "next/server";
import { defaultVidiqRouteDeps, vidiqHandler, type VidiqRouteDeps } from "./shared";

// BL-278: the card's status -- the key's state and last 4 characters, the switch, the balance snapshot, the budget and the 20 newest
// ledger rows. Local data only: no vidIQ call.
export function createVidiqStatusGetHandler(deps: VidiqRouteDeps = defaultVidiqRouteDeps()) {
  return vidiqHandler(deps, async ({ core }) => NextResponse.json(await core.getStatus()));
}

export const GET = createVidiqStatusGetHandler();
