import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createCloudConnectionCore } from "@/lib/cloud-connection";
import { cloudConnectionCallbackRedirectUri } from "@/lib/cloud-connection/redirect-uri";

export const CLOUD_CONNECTION_STATE_COOKIE = "cloud_connection_oauth_state";

/**
 * Starts the Cloud connection flow (`docs/decisions/0008-cloud-connection.md`): a full-page
 * redirect to Google's consent screen, entirely separate from the NextAuth channel-login flow --
 * this grant is never tied to which YouTube channel/login is currently active. `state` is stored
 * in a short-lived httpOnly cookie (not a query param, not a DB row) so the callback can verify
 * the redirect actually came from a consent screen this same browser started, mirroring the CSRF
 * protection every other OAuth entry point in this app already applies.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { authUrl, state } = createCloudConnectionCore().beginConnect({
    redirectUri: cloudConnectionCallbackRedirectUri(),
  });

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(CLOUD_CONNECTION_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 600,
    path: "/api/cloud-connection",
  });
  return response;
}
