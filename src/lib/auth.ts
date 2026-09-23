import type { NextAuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import CredentialsProvider from "next-auth/providers/credentials";
import { getToken } from "next-auth/jwt";
import { google } from "googleapis";
import { createHash, randomBytes } from "node:crypto";
import { upsertUserOAuthOnSignIn } from "./db";
// `channel-connections/index.ts` imports `revokeGoogleToken` from this very file, so importing it
// statically here would create a module-init circular dependency -- loaded lazily instead, inside
// the Credentials provider's `authorize()` below, via a dynamic `import()`.

export const YOUTUBE_READ_SCOPE =
  "https://www.googleapis.com/auth/youtube.readonly";
export const YOUTUBE_WRITE_SCOPE = "https://www.googleapis.com/auth/youtube";
export const YOUTUBE_FORCE_SSL_SCOPE =
  "https://www.googleapis.com/auth/youtube.force-ssl";
// Phase 8 (Intelligence Foundation), BL-056 -- owner-approved 2026-09-22 (Telegram msg 356,
// "Да, разрешаю", answering the exact scope named in msg 355). Read-only access to the YouTube
// Analytics API's channel/video reports (`docs/roadmap/plans/PHASE_8_PLAN.md` §10 item 1/2) --
// deliberately NOT `yt-analytics-monetary.readonly` (revenue metrics), which was never asked
// about or approved and requires separate YouTube Partner Program / CMS access.
export const YOUTUBE_ANALYTICS_READ_SCOPE =
  "https://www.googleapis.com/auth/yt-analytics.readonly";

export const GOOGLE_AUTH_BASE_SCOPES = ["openid", "email", "profile"] as const;
export const YOUTUBE_SCOPES = [
  ...GOOGLE_AUTH_BASE_SCOPES,
  YOUTUBE_READ_SCOPE,
  YOUTUBE_WRITE_SCOPE,
  YOUTUBE_FORCE_SSL_SCOPE,
  YOUTUBE_ANALYTICS_READ_SCOPE,
] as const;

export const YOUTUBE_SCOPES_STRING = YOUTUBE_SCOPES.join(" ");

export type OAuthTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiry: number | null;
  scope: string | null;
  idToken: string | null;
};

export type GoogleIdentity = {
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
};

function toBase64Url(buffer: Buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function generateOAuthState() {
  return toBase64Url(randomBytes(24));
}

export function generatePkcePair() {
  const verifier = toBase64Url(randomBytes(64));
  const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createGoogleOAuthClient(redirectUri?: string) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

export function buildGoogleLoopbackAuthUrl(args: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes?: readonly string[];
}) {
  const oauthClient = createGoogleOAuthClient(args.redirectUri);
  const authUrl = oauthClient.generateAuthUrl({
    access_type: "offline",
    prompt: "select_account consent",
    scope: (args.scopes ?? YOUTUBE_SCOPES) as string[],
    state: args.state,
    redirect_uri: args.redirectUri,
  });

  const url = new URL(authUrl);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("code_challenge", args.codeChallenge);
  return url.toString();
}

function mapTokenSet(credentials: {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  scope?: string | null;
  id_token?: string | null;
}): OAuthTokenSet {
  if (!credentials.access_token) {
    throw new Error("OAuth token exchange did not return access_token");
  }

  return {
    accessToken: credentials.access_token,
    refreshToken: credentials.refresh_token ?? null,
    tokenExpiry: credentials.expiry_date ? Math.floor(credentials.expiry_date / 1000) : null,
    scope: credentials.scope ?? null,
    idToken: credentials.id_token ?? null,
  };
}

export async function exchangeGoogleAuthCode(args: {
  redirectUri: string;
  code: string;
  codeVerifier: string;
}): Promise<OAuthTokenSet> {
  const oauthClient = createGoogleOAuthClient(args.redirectUri);
  const tokenResponse = await oauthClient.getToken({
    code: args.code,
    codeVerifier: args.codeVerifier,
    redirect_uri: args.redirectUri,
  });

  return mapTokenSet(tokenResponse.tokens);
}

export type DeviceAuthorizationStart = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string | null;
  expiresIn: number;
  interval: number;
};

export async function startGoogleDeviceAuthorization(args?: {
  scopes?: readonly string[];
}): Promise<DeviceAuthorizationStart> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("GOOGLE_CLIENT_ID is required");
  }

  const response = await fetch("https://oauth2.googleapis.com/device/code", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      scope: (args?.scopes ?? YOUTUBE_SCOPES).join(" "),
    }),
  });

  const payload = (await response.json()) as {
    device_code?: string;
    user_code?: string;
    verification_url?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.device_code || !payload.user_code) {
    throw new Error(payload.error_description ?? payload.error ?? "Device authorization failed");
  }

  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUrl: payload.verification_uri ?? payload.verification_url ?? "",
    verificationUrlComplete: payload.verification_uri_complete ?? null,
    expiresIn: payload.expires_in ?? 300,
    interval: payload.interval ?? 5,
  };
}

export async function pollGoogleDeviceAuthorizationToken(args: {
  deviceCode: string;
  intervalSeconds: number;
  expiresInSeconds: number;
  signal?: AbortSignal;
}): Promise<OAuthTokenSet> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required");
  }

  const deadline = Date.now() + args.expiresInSeconds * 1000;
  let interval = Math.max(2, args.intervalSeconds);

  while (Date.now() < deadline) {
    if (args.signal?.aborted) {
      throw new Error("Device authorization was cancelled");
    }

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        device_code: args.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      scope?: string;
      expires_in?: number;
      id_token?: string;
      error?: string;
      error_description?: string;
    };

    if (response.ok && payload.access_token) {
      return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? null,
        tokenExpiry: payload.expires_in
          ? Math.floor(Date.now() / 1000) + payload.expires_in
          : null,
        scope: payload.scope ?? null,
        idToken: payload.id_token ?? null,
      };
    }

    if (payload.error === "authorization_pending") {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      continue;
    }

    if (payload.error === "slow_down") {
      interval += 5;
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      continue;
    }

    if (payload.error === "access_denied") {
      throw new Error("Device authorization denied by user");
    }

    throw new Error(payload.error_description ?? payload.error ?? "Device authorization failed");
  }

  throw new Error("Device authorization timed out");
}

function decodeIdentityFromIdToken(idToken: string | null): GoogleIdentity | null {
  if (!idToken) return null;

  const [, payloadBase64] = idToken.split(".");
  if (!payloadBase64) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8")) as {
      sub?: string;
      email?: string;
      name?: string;
      picture?: string;
    };

    if (!decoded.sub || !decoded.email) return null;

    return {
      userId: decoded.sub,
      email: decoded.email,
      name: decoded.name ?? null,
      image: decoded.picture ?? null,
    };
  } catch {
    return null;
  }
}

export async function fetchGoogleIdentity(args: {
  accessToken: string;
  idToken?: string | null;
}): Promise<GoogleIdentity> {
  const fromIdToken = decodeIdentityFromIdToken(args.idToken ?? null);
  if (fromIdToken) return fromIdToken;

  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      authorization: `Bearer ${args.accessToken}`,
    },
  });

  const payload = (await response.json()) as {
    sub?: string;
    email?: string;
    name?: string;
    picture?: string;
  };

  if (!response.ok || !payload.sub || !payload.email) {
    throw new Error("Unable to fetch user identity from Google");
  }

  return {
    userId: payload.sub,
    email: payload.email,
    name: payload.name ?? null,
    image: payload.picture ?? null,
  };
}

/**
 * NextAuth's own `SessionStore` (node_modules/next-auth/core/lib/cookie.js) reads only
 * `req.cookies` -- never `req.headers.cookie` as a raw string -- but the `req` the
 * "channel-connections" Credentials provider's `authorize()` receives (App Router adapter,
 * next-auth v4.24) has `headers` but no parsed `cookies`, so `getToken({req})` would otherwise
 * silently see no cookies at all and always return null. This parses the raw header into the
 * `Map` shape `SessionStore`'s constructor already special-cases (also correctly reassembling a
 * JWT split across `next-auth.session-token.0`/`.1`/... chunks, the same way it would from a real
 * parsed `cookies` object).
 *
 * `decodeURIComponent` is wrapped per-cookie, not once for the whole header: an unrelated cookie
 * on the same origin (an ad/analytics cookie, another app, a stale malformed value) with invalid
 * percent-encoding must never be able to abort parsing before the loop reaches the actual session
 * cookie -- that cookie is simply skipped instead of throwing out of the whole function.
 *
 * On a duplicate cookie name (a browser can legitimately send the same name scoped to two
 * different paths in one header), the FIRST occurrence wins, matching the `cookie` npm package's
 * own `parse()` behavior (verified against `node_modules/cookie`) -- this is the same convention
 * `getServerSession()`'s own cookie parsing already follows elsewhere in this app, so this
 * function resolves the same identity `getServerSession()` would for the same request.
 */
export function parseCookieHeader(rawCookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of rawCookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!name || cookies.has(name)) continue;
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      continue;
    }
  }
  return cookies;
}

/** Resolves the already-existing session token (if any) from a raw, unparsed request -- see
 * `parseCookieHeader`'s doc comment for why this can't just delegate to `getToken({req})`
 * directly. Does not itself weaken any verification `getToken`/`decode` perform: the returned
 * token is only ever non-null for a cookie value that decrypts and verifies successfully against
 * `NEXTAUTH_SECRET` (AEAD-encrypted JWE, `next-auth/jwt`'s own `decode`) -- this function only
 * fixes *finding* the cookie, never bypasses checking it. */
export async function resolveExistingSessionToken(
  req: { headers?: Record<string, string> } | undefined
) {
  const cookies = parseCookieHeader(req?.headers?.cookie ?? "");
  return getToken({
    req: { headers: req?.headers, cookies } as unknown as Parameters<typeof getToken>[0]["req"],
    secret: process.env.NEXTAUTH_SECRET,
  });
}

export async function revokeGoogleToken(token: string): Promise<void> {
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });

  if (!response.ok) {
    throw new Error("Google token revoke request failed");
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          scope: YOUTUBE_SCOPES_STRING,
          access_type: "offline",
          prompt: "select_account consent",
        },
      },
    }),
    // `docs/decisions/0010-persistent-channel-connections.md` -- reactivates an already-connected
    // channel's stored identity (its tokens already live in `users`, never deleted between
    // sessions) without a Google round-trip. Never rendered on any sign-in page (this app's login
    // page, `src/app/page.tsx`, calls `signIn("google")` directly rather than NextAuth's default
    // multi-provider chooser) -- only the Settings "Channels" section's "Activate" button invokes
    // this provider by id, explicitly.
    CredentialsProvider({
      id: "channel-connections",
      name: "Stored channel",
      credentials: { channelId: { label: "Channel ID", type: "text" } },
      async authorize(credentials, req) {
        // Requires an already-valid existing session before activating a stored channel -- this
        // is a privileged action gated on already being signed into this app somehow, exactly
        // like every Cloud connection route requires an active session (ADR 0008). Never an
        // independent, unauthenticated way to assume any locally-known identity.
        const existingToken = await resolveExistingSessionToken(
          req as { headers?: Record<string, string> } | undefined
        );
        if (!existingToken) return null;

        const channelId = credentials?.channelId;
        if (!channelId) return null;

        const { createChannelConnectionsCore, isDomainError } = await import("./channel-connections");

        try {
          const identity = await createChannelConnectionsCore().resolveChannelIdentityForActivation(channelId);
          return { id: identity.userId, email: identity.email, name: identity.name, image: identity.image };
        } catch (err) {
          if (isDomainError(err)) return null;
          throw err;
        }
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (!account) return false;

      // A "channel-connections" sign-in reactivates an already-stored identity -- its `users` row
      // already has the real, correctly-scoped tokens. Its synthetic `account` carries no real
      // OAuth tokens, so running the upsert below unconditionally would silently null out that
      // identity's perfectly good, already-stored tokens.
      if (account.provider === "channel-connections") {
        return true;
      }

      await upsertUserOAuthOnSignIn({
        userId: user.id,
        name: user.name ?? null,
        email: user.email!,
        image: user.image ?? null,
        accessToken: account.access_token ?? null,
        refreshToken: account.refresh_token ?? null,
        tokenExpiry: account.expires_at ?? null,
        scope: account.scope ?? null,
      });

      return true;
    },
    async session({ session, token }) {
      if (token.sub) {
        session.user = { ...session.user, id: token.sub };
      }
      return session;
    },
    async jwt({ token }) {
      return token;
    },
  },
};
