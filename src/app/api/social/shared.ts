import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createCrossPostingCore, DomainError, type CrossPostingCore } from "@/lib/cross-posting";
import { isLoopbackRequest, isRemoteRequest } from "@/lib/loopback-guard";
import { isDomainError } from "@/lib/shared-domain";

// BL-252 (ADR 0068): the owner's routes for Settings → Channels → Social networks. Web session required (401); a thin call into
// the one core; DomainError -> status. No route returns a token or the App Secret. Never reachable from MCP. Saving the App Secret
// and disconnecting are Mac-only (proxy REMOTE_BLOCKED_PREFIXES); connecting also works from the owner's phone over Tailscale.

export type SocialRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: CrossPostingCore;
};

export function defaultSocialRouteDeps(): SocialRouteDeps {
  return {
    getSession: () => getServerSession(authOptions),
    get core() {
      return createCrossPostingCore();
    },
  };
}

export function errorResponse(error: unknown): NextResponse {
  if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

export function socialHandler(deps: SocialRouteDeps, run: (args: { core: CrossPostingCore; request: Request }) => Promise<NextResponse>) {
  return async function handler(request: Request): Promise<NextResponse> {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return await run({ core: deps.core, request });
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new DomainError({ code: "validation_failed", message: "Request body must be valid JSON" });
  }
}

export const META_CALLBACK_PATH = "/api/social/meta/callback";

function hostParts(host: string): { hostname: string; port: string } | null {
  const m = /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(host.trim());
  return m ? { hostname: m[1].toLowerCase(), port: m[2] ?? "" } : null;
}

/**
 * The redirect URI Meta must send the owner back to -- the address the owner's browser is on: `http://localhost:<port>` on the
 * Mac, `https://<mac>.<tailnet>.ts.net` over Tailscale. Anything else (a foreign page aiming at localhost, an odd Host) is refused.
 * Both addresses are listed in the card to be entered once in the Meta app's "Valid OAuth Redirect URIs".
 */
export function redirectUriFor(headers: Headers): string {
  const host = hostParts(headers.get("host") ?? "");
  if (host && isRemoteRequest(headers) && host.hostname.endsWith(".ts.net")) return `https://${host.hostname}${META_CALLBACK_PATH}`;
  if (host && isLoopbackRequest(headers)) return `http://localhost${host.port ? `:${host.port}` : ""}${META_CALLBACK_PATH}`;
  throw new DomainError({ code: "remote_access_mac_only", message: "Connect from the Mac (localhost) or from the owner's Tailscale address." });
}
