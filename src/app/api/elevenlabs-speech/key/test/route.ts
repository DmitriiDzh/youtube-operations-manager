import { NextResponse } from "next/server";
import { defaultElevenlabsRouteDeps, elevenlabsHandler, type ElevenlabsRouteDeps } from "../../shared";

// BL-236: checks the stored key with ElevenLabs again (the free subscription read; nothing generated or charged).
export function createElevenlabsKeyTestPostHandler(deps: ElevenlabsRouteDeps = defaultElevenlabsRouteDeps()) {
  return elevenlabsHandler(deps, async ({ core }) => NextResponse.json(await core.testKey()));
}

export const POST = createElevenlabsKeyTestPostHandler();
