import { NextResponse } from "next/server";
import { isDomainError } from "@/lib/shared-domain";
import { defaultSocialRouteDeps, redirectUriFor, type SocialRouteDeps } from "../../shared";

// BL-252: where Meta sends the owner's browser after consent. Authorised by the single-use `state` the connect made (and the
// Web session); on success the browser lands on Settings → Channels with the Pages to pick from, otherwise with the error code.
const SETTINGS_PATH = "/settings/channels";

export function createMetaCallbackHandler(deps: SocialRouteDeps = defaultSocialRouteDeps()) {
  return async function handler(request: Request): Promise<NextResponse> {
    const url = new URL(request.url);
    const back = (params: Record<string, string>) => {
      const target = new URL(SETTINGS_PATH, url.origin);
      for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
      // A relative Location keeps the browser on the address it is on (localhost or the Tailscale name).
      return new NextResponse(null, { status: 303, headers: { location: `${target.pathname}${target.search}`, "cache-control": "no-store" } });
    };
    const session = await deps.getSession();
    if (!session?.user?.id) return back({ socialError: "unauthorized" });
    if (url.searchParams.get("error")) return back({ socialError: "consent_cancelled" });
    try {
      const { pickId } = await deps.core.completeConnect({ state: url.searchParams.get("state"), code: url.searchParams.get("code"), redirectUri: redirectUriFor(request.headers) });
      return back({ socialPick: pickId });
    } catch (error) {
      return back({ socialError: isDomainError(error) ? error.code : "internal_error" });
    }
  };
}

export const GET = createMetaCallbackHandler();
