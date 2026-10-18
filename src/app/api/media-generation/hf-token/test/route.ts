import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, type MediaRouteDeps } from "../../shared";

// BL-134: «Проверить» -- one Hugging Face `whoami` with the stored token; answers the public view only.
export function createHfTokenTestHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => NextResponse.json(await core.testHfToken()));
}

export const POST = createHfTokenTestHandler();
