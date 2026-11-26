import { NextResponse } from "next/server";
import { defaultVidiqRouteDeps, vidiqHandler, type VidiqRouteDeps } from "../shared";

// BL-278: the owner's «Обновить» -- one free `vidiq_balance` read; answers the new status.
export function createVidiqBalancePostHandler(deps: VidiqRouteDeps = defaultVidiqRouteDeps()) {
  return vidiqHandler(deps, async ({ core }) => NextResponse.json(await core.refreshBalance()));
}

export const POST = createVidiqBalancePostHandler();
