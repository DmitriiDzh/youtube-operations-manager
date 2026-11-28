import { NextResponse } from "next/server";
import { defaultVidiqRouteDeps, vidiqHandler, type VidiqRouteDeps } from "../shared";

// ADR 0077 amendment 1: the owner's «Разблокировать» -- the overcharges recorded so far no longer block their tools (local only,
// nothing is sent to vidIQ; the ledger rows stay and still count). Answers the status.
export function createVidiqOverchargeAckPostHandler(deps: VidiqRouteDeps = defaultVidiqRouteDeps()) {
  return vidiqHandler(deps, async ({ core }) => NextResponse.json(await core.acknowledgeOvercharges()));
}

export const POST = createVidiqOverchargeAckPostHandler();
