import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, type MediaRouteDeps } from "../shared";

/**
 * Slice 6 (AC-P14-25): the connected RunPod account's balance for Production -- the legacy GraphQL balance, or, when
 * that read fails, the v2 billing spend (`source` says which). One RunPod read per call; nothing cached or stored.
 */
export function createBalanceGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json({ balance: await core.getAccountBalance() }));
}

export const GET = createBalanceGetHandler();
