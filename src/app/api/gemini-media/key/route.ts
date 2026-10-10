import { NextResponse } from "next/server";
import { defaultGeminiRouteDeps, geminiHandler, readJsonBody, type GeminiRouteDeps } from "../shared";

// BL-174: the ONLY way the Gemini API key enters this app; it leaves only as its last 4 characters and status.
export function createGeminiKeyPutHandler(deps: GeminiRouteDeps = defaultGeminiRouteDeps()) {
  return geminiHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.setKey(body.body));
  });
}

export function createGeminiKeyDeleteHandler(deps: GeminiRouteDeps = defaultGeminiRouteDeps()) {
  return geminiHandler(deps, async ({ core }) => NextResponse.json(await core.clearKey()));
}

export const PUT = createGeminiKeyPutHandler();
export const DELETE = createGeminiKeyDeleteHandler();
