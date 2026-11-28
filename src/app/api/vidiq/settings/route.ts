import { NextResponse } from "next/server";
import { defaultVidiqRouteDeps, readJsonBody, vidiqHandler, type VidiqRouteDeps } from "../shared";

// BL-278: the switch (on only with a saved key) and the monthly credits budget.
export function createVidiqSettingsPatchHandler(deps: VidiqRouteDeps = defaultVidiqRouteDeps()) {
  return vidiqHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.updateSettings(body.body));
  });
}

export const PATCH = createVidiqSettingsPatchHandler();
