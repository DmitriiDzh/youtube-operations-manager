import { NextResponse } from "next/server";
import { defaultGeminiRouteDeps, geminiHandler, type GeminiRouteDeps } from "../shared";

// BL-188 stage 4: what Media's Gemini form needs on THIS computer -- the switch, whether a key is stored (its last 4 characters
// only), the limits and spend, and the model catalog with prices. Session required (401). Read-only.
export function createGeminiStatusGetHandler(deps: GeminiRouteDeps = defaultGeminiRouteDeps()) {
  return geminiHandler(deps, async ({ core }) => NextResponse.json(await core.getStatus()));
}

export const GET = createGeminiStatusGetHandler();
