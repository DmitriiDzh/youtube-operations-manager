import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createCloudConnectionCore } from "@/lib/cloud-connection";
import { isDomainError } from "@/lib/cloud-connection/contracts";
import { cloudConnectionCallbackRedirectUri } from "@/lib/cloud-connection/redirect-uri";
import { CLOUD_CONNECTION_STATE_COOKIE } from "../start/route";

// A small, closed set of reasons the Settings card (cloud-connection-settings.tsx) maps to a
// specific, actionable message -- the owner reported that one generic "Connection failed" message
// for every possible failure gave no way to tell them apart. Anything not on this list (an
// unclassified thrown error) falls back to `"unknown"`; the real error is always still logged
// server-side below regardless of which reason is reported to the browser.
type CloudConnectionFailureReason =
  | "oauth_denied"
  | "missing_callback_params"
  | "state_cookie_missing"
  | "AUTH_CALLBACK_INVALID"
  | "CLOUD_CONNECTION_TOKEN_EXCHANGE_FAILED"
  | "encryption_key_not_configured"
  | "unknown";

const KNOWN_DOMAIN_ERROR_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "AUTH_CALLBACK_INVALID",
  "CLOUD_CONNECTION_TOKEN_EXCHANGE_FAILED",
  "encryption_key_not_configured",
] satisfies CloudConnectionFailureReason[]);

function isKnownFailureReason(
  code: string
): code is "AUTH_CALLBACK_INVALID" | "CLOUD_CONNECTION_TOKEN_EXCHANGE_FAILED" | "encryption_key_not_configured" {
  return KNOWN_DOMAIN_ERROR_FAILURE_REASONS.has(code);
}

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

  function fail(reason: CloudConnectionFailureReason) {
    redirectTo.searchParams.set("cloudConnection", "error");
    redirectTo.searchParams.set("cloudConnectionReason", reason);
  }

  if (oauthError) {
    // Google's own callback `error` param (e.g. "access_denied" when the operator declines
    // consent) -- logged below for the rarer non-`access_denied` cases; the Settings card shows
    // one message covering the common case without needing every possible OAuth error string.
    console.error(JSON.stringify({
      level: "error",
      event: "cloud_connection.oauth_denied",
      context: { oauthError },
    }));
    fail("oauth_denied");
  } else if (!code || !state) {
    fail("missing_callback_params");
  } else if (!expectedState) {
    // Most often: the state cookie expired (the flow took over 10 minutes), the browser blocked
    // it, or this link was opened again after already completing/abandoning an earlier attempt.
    fail("state_cookie_missing");
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
      fail(isDomainError(error) && isKnownFailureReason(error.code) ? error.code : "unknown");
    }
  }

  const response = NextResponse.redirect(redirectTo);
  response.cookies.delete({ name: CLOUD_CONNECTION_STATE_COOKIE, path: "/api/cloud-connection" });
  return response;
}
