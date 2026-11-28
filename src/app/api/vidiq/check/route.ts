import { NextResponse } from "next/server";
import { defaultVidiqRouteDeps, vidiqHandler, type VidiqRouteDeps } from "../shared";

// BL-278: «Проверить подключение» -- the free `tools/list` and a drift row per allowlisted tool.
export function createVidiqCheckPostHandler(deps: VidiqRouteDeps = defaultVidiqRouteDeps()) {
  return vidiqHandler(deps, async ({ core }) => NextResponse.json(await core.checkConnection()));
}

export const POST = createVidiqCheckPostHandler();
