import { NextResponse } from "next/server";
import { defaultGeminiRouteDeps, geminiHandler, readJsonBody, type GeminiRouteDeps } from "../shared";

// BL-174: the owner's switch ("the operator may generate, paid") and limits. Never reachable from MCP.
export function createGeminiSettingsPutHandler(deps: GeminiRouteDeps = defaultGeminiRouteDeps()) {
  return geminiHandler(deps, async ({ core, request }) => {
    const body = await readJsonBody(request);
    if (!body.ok) return body.response;
    return NextResponse.json(await core.updateSettings(body.body));
  });
}

export const PUT = createGeminiSettingsPutHandler();
