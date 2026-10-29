import { NextResponse } from "next/server";
import { defaultElevenlabsRouteDeps, elevenlabsHandler, type ElevenlabsRouteDeps } from "../shared";

/**
 * BL-236 (owner msg 3823, as the Gemini limits): where the shared ElevenLabs character limits stand on this computer -- applied, held
 * and why, and the conflicts waiting for the owner's choice (the startup window and Merge read it). A local read that never applies.
 */
export function createElevenlabsSettingsSyncGetHandler(deps: ElevenlabsRouteDeps = defaultElevenlabsRouteDeps()) {
  return elevenlabsHandler(deps, async ({ core }) => {
    const status = core.getSettingsSyncStatus();
    const fresh = status.checkedAt !== null && Date.now() - Date.parse(status.checkedAt) < 15_000;
    return NextResponse.json(fresh ? status : await core.peekSettingsSync());
  });
}

export const GET = createElevenlabsSettingsSyncGetHandler();
