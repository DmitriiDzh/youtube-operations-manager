import { NextResponse } from "next/server";
import { defaultGeminiRouteDeps, geminiHandler, type GeminiRouteDeps } from "../../shared";

// BL-174: checks the stored key with Google again (one models.list page, no generation, nothing paid).
export function createGeminiKeyTestPostHandler(deps: GeminiRouteDeps = defaultGeminiRouteDeps()) {
  return geminiHandler(deps, async ({ core }) => NextResponse.json(await core.testKey()));
}

export const POST = createGeminiKeyTestPostHandler();
