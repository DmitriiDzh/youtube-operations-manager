import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createCloudConnectionCore } from "@/lib/cloud-connection";
import { cloudConnectionCallbackRedirectUri } from "@/lib/cloud-connection/redirect-uri";
import { CLOUD_CONNECTION_STATE_COOKIE } from "../start/route";

/**
 * Completes the Cloud connection flow started by `/api/cloud-connection/start`
 * (`docs/decisions/0008-cloud-connection.md`). Always redirects back to the dashboard --
 * this is a full-page browser navigation from Google's own consent screen, never an XHR/fetch
 * call, so there is no JSON response to return here even on failure.
 *
 * Catches EVERY error from `completeConnect`, not only `DomainError` -- found live (2026-09-22):
 * an unexpected error (`fetchGoogleIdentity` throwing "Unable to fetch user identity from
 * Google") propagated past an earlier version of this route that only caught `DomainError`,
 * surfacing as a raw framework 500 page ("localhost is currently unable to handle this
 * request") instead of a clean redirect the Settings card can explain. A full-page OAuth
 * redirect boundary has no JS error handling available to the browser either way, so there is
 * no upside to distinguishing error types here -- only the real error, logged server-side, is
 * lost if this route lets anything propagate.
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const cookieHeader = request.headers.get("cookie") ?? "";
  const expectedState = cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${CLOUD_CONNECTION_STATE_COOKIE}=`))
    ?.slice(CLOUD_CONNECTION_STATE_COOKIE.length + 1);

  const redirectTo = new URL("/dashboard", url.origin);

  if (oauthError || !code || !state || !expectedState) {
    redirectTo.searchParams.set("cloudConnection", "error");
  } else {
    try {
      await createCloudConnectionCore().completeConnect({
        code,
        state,
        expectedState,
        redirectUri: cloudConnectionCallbackRedirectUri(),
      });
      redirectTo.searchParams.set("cloudConnection", "connected");
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "cloud_connection.complete_connect.failed",
        context: { message: error instanceof Error ? error.message : "Unknown error" },
      }));
      redirectTo.searchParams.set("cloudConnection", "error");
    }
  }

  const response = NextResponse.redirect(redirectTo);
  response.cookies.delete({ name: CLOUD_CONNECTION_STATE_COOKIE, path: "/api/cloud-connection" });
  return response;
}
