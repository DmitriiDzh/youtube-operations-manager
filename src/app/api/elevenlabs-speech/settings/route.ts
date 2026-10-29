import { NextResponse } from "next/server";
import { defaultElevenlabsRouteDeps, elevenlabsHandler, readJsonBody, type ElevenlabsRouteDeps } from "../shared";

// BL-236: the owner's switch for this computer, the character limits and the output format. Never reachable from MCP.
export function createElevenlabsSettingsPutHandler(deps: ElevenlabsRouteDeps = defaultElevenlabsRouteDeps()) {
  return elevenlabsHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.updateSettings(body.body));
  });
}

export const PUT = createElevenlabsSettingsPutHandler();
