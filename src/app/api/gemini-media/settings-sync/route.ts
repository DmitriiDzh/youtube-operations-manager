import { NextResponse } from "next/server";
import { defaultGeminiRouteDeps, geminiHandler, type GeminiRouteDeps } from "../shared";

/**
 * BL-193 (ADR 0039): where the shared Gemini limits stand on this computer -- what was applied from the other computers, what is
 * held and why, and the conflicts waiting for the owner's choice (the startup window and Merge read it). A local read: checked more
 * than 15 s ago (or never) it reads the document now, and it never writes or applies anything (applying is the Gemini loop's).
 */
export function createGeminiSettingsSyncGetHandler(deps: GeminiRouteDeps = defaultGeminiRouteDeps()) {
  return geminiHandler(deps, async ({ core }) => {
    const status = core.getSettingsSyncStatus();
    const fresh = status.checkedAt !== null && Date.now() - Date.parse(status.checkedAt) < 15_000;
    return NextResponse.json(fresh ? status : await core.peekSettingsSync());
  });
}

export const GET = createGeminiSettingsSyncGetHandler();
