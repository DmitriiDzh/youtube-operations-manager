import { NextResponse } from "next/server";
import { defaultGeminiRouteDeps, geminiHandler, type GeminiRouteDeps } from "./shared";

// BL-174: everything Settings → Gemini shows in one read -- the key's public view, the switch and limits, the spend (this
// computer), the gateway toggle and the 20 newest jobs.
export function createGeminiOverviewGetHandler(deps: GeminiRouteDeps = defaultGeminiRouteDeps()) {
  return geminiHandler(deps, async ({ core }) => {
    const [key, settings, status, recent] = await Promise.all([core.getKey(), core.getSettings(), core.getStatus(), core.getJobs({ limit: 20 })]);
    return NextResponse.json({ key, settings, spend: status.spend, gatewayEnabled: status.gatewayEnabled, pricesAsOf: status.pricesAsOf, jobs: "jobs" in recent ? recent.jobs : [] });
  });
}

export const GET = createGeminiOverviewGetHandler();
