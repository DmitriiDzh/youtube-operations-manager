import {
  createGoogleOAuthClient,
  fetchGoogleIdentity,
  generateOAuthState,
  revokeGoogleToken,
} from "@/lib/auth";
import { decryptSecret, encryptSecret, requireEncryptionKey, type ResolveEncryptionKey } from "./crypto";
import { CLOUD_CONNECTION_REQUESTED_SCOPES, DomainError, type CloudConnectionStatus } from "./contracts";
import { completeConnectInputSchema, parseWithSchema } from "./schemas";

type StoredCloudConnection = {
  connectedEmail: string;
  scope: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  connectedAt: Date;
};

type StoredTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiry: number | null;
};

type ServiceDependencies = {
  store: {
    get(): Promise<StoredCloudConnection | null>;
    upsert(input: { connectedEmail: string; scope: string; ciphertext: string; iv: string; authTag: string }): Promise<void>;
    clear(): Promise<void>;
  };
  oauth: {
    createOAuthClient: typeof createGoogleOAuthClient;
    fetchIdentity: typeof fetchGoogleIdentity;
    revokeToken: typeof revokeGoogleToken;
    generateState: typeof generateOAuthState;
  };
  resolveEncryptionKey: ResolveEncryptionKey;
  clock: { now(): Date };
};

function encryptTokenSet(tokens: StoredTokenSet, deps: ServiceDependencies) {
  const key = requireEncryptionKey(deps.resolveEncryptionKey);
  return encryptSecret(JSON.stringify(tokens), key);
}

function decryptTokenSet(stored: StoredCloudConnection, deps: ServiceDependencies): StoredTokenSet {
  const key = requireEncryptionKey(deps.resolveEncryptionKey);
  const plaintext = decryptSecret(stored, key);
  return JSON.parse(plaintext) as StoredTokenSet;
}

export function createCloudConnectionServices(deps: ServiceDependencies) {
  return {
    /**
     * Public status -- never the token. Called by the Settings tab and by
     * `/api/cloud-connection/status`.
     */
    async getStatus(): Promise<CloudConnectionStatus> {
      const stored = await deps.store.get();
      if (!stored) return { connected: false };
      return {
        connected: true,
        connectedEmail: stored.connectedEmail,
        scope: stored.scope,
        connectedAt: stored.connectedAt.toISOString(),
      };
    },

    /**
     * Builds the Google consent URL. The caller (the `/api/cloud-connection/start` route) is
     * responsible for persisting `state` (an httpOnly cookie) so the callback can verify it --
     * this function is pure request-shaping, no side effect on the stored connection.
     */
    beginConnect(args: { redirectUri: string }): { authUrl: string; state: string } {
      const state = deps.oauth.generateState();
      const oauthClient = deps.oauth.createOAuthClient(args.redirectUri);
      const authUrl = oauthClient.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [...CLOUD_CONNECTION_REQUESTED_SCOPES],
        state,
        redirect_uri: args.redirectUri,
      });
      return { authUrl, state };
    },

    /**
     * Exchanges the authorization code for tokens, fetches the connected account's email (shown
     * in Settings, never used for anything else -- this grant is entirely independent of channel
     * identity), encrypts the token set, and persists it as the one `cloud_connection` row.
     */
    async completeConnect(input: unknown): Promise<CloudConnectionStatus> {
      const parsed = parseWithSchema(completeConnectInputSchema, input, "cloud connection callback input");

      if (parsed.state !== parsed.expectedState) {
        throw new DomainError({
          code: "AUTH_CALLBACK_INVALID",
          message: "Cloud connection callback state mismatch",
        });
      }

      const oauthClient = deps.oauth.createOAuthClient(parsed.redirectUri);
      let tokenResponse;
      try {
        tokenResponse = await oauthClient.getToken({
          code: parsed.code,
          redirect_uri: parsed.redirectUri,
        });
      } catch (error) {
        // Most common real cause: `parsed.redirectUri` was never added to the OAuth client's own
        // "Authorized redirect URIs" in Google Cloud Console (docs/decisions/0008-cloud-connection.md
        // -- a separate redirect URI from the one NextAuth's channel-login flow already uses), or
        // the authorization code already expired/was already used. Wrapped with its own code so the
        // callback route (and, in turn, the Settings card) can say this specifically instead of a
        // generic "Connection failed."
        throw new DomainError({
          code: "CLOUD_CONNECTION_TOKEN_EXCHANGE_FAILED",
          message: `Cloud connection token exchange failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }

      const accessToken = tokenResponse.tokens.access_token;
      if (!accessToken) {
        throw new DomainError({
          code: "CLOUD_CONNECTION_TOKEN_EXCHANGE_FAILED",
          message: "Cloud connection token exchange did not return an access token",
        });
      }

      const identity = await deps.oauth.fetchIdentity({
        accessToken,
        idToken: tokenResponse.tokens.id_token ?? null,
      });

      const tokens: StoredTokenSet = {
        accessToken,
        refreshToken: tokenResponse.tokens.refresh_token ?? null,
        tokenExpiry: tokenResponse.tokens.expiry_date
          ? Math.floor(tokenResponse.tokens.expiry_date / 1000)
          : null,
      };
      const encrypted = encryptTokenSet(tokens, deps);

      await deps.store.upsert({
        connectedEmail: identity.email,
        scope: tokenResponse.tokens.scope ?? CLOUD_CONNECTION_REQUESTED_SCOPES.join(" "),
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
      });

      const stored = await deps.store.get();
      if (!stored) {
        throw new DomainError({ code: "unauthorized", message: "Cloud connection was not persisted" });
      }

      return {
        connected: true,
        connectedEmail: stored.connectedEmail,
        scope: stored.scope,
        connectedAt: stored.connectedAt.toISOString(),
      };
    },

    /** Revokes the token with Google, then clears the stored row regardless of whether the
     * revoke call itself succeeded (a token Google no longer recognizes must not be left stored
     * as if it were still usable). */
    async disconnect(): Promise<void> {
      const stored = await deps.store.get();
      if (!stored) return;

      const tokens = decryptTokenSet(stored, deps);
      try {
        await deps.oauth.revokeToken(tokens.refreshToken ?? tokens.accessToken);
      } finally {
        await deps.store.clear();
      }
    },

    /**
     * Returns a valid access token, refreshing first if the stored one has expired. This is the
     * one function a future Cloud Quotas/Monitoring slice will call -- no such call exists yet in
     * this slice.
     */
    async resolveCloudCredentials(): Promise<{ accessToken: string }> {
      const stored = await deps.store.get();
      if (!stored) {
        throw new DomainError({
          code: "unauthorized",
          message: "No Cloud connection is configured. Connect one in Settings first.",
        });
      }

      const tokens = decryptTokenSet(stored, deps);
      const now = Math.floor(deps.clock.now().getTime() / 1000);
      const isExpired = typeof tokens.tokenExpiry === "number" && tokens.tokenExpiry <= now;

      if (!isExpired) {
        return { accessToken: tokens.accessToken };
      }

      if (!tokens.refreshToken) {
        throw new DomainError({
          code: "unauthorized",
          message: "Cloud connection access token expired and no refresh token is stored",
        });
      }

      const oauthClient = deps.oauth.createOAuthClient();
      oauthClient.setCredentials({ refresh_token: tokens.refreshToken });

      let refreshed;
      try {
        refreshed = await oauthClient.refreshAccessToken();
      } catch {
        throw new DomainError({ code: "unauthorized", message: "Cloud connection token refresh failed" });
      }

      const refreshedTokens: StoredTokenSet = {
        accessToken: refreshed.credentials.access_token ?? tokens.accessToken,
        refreshToken: refreshed.credentials.refresh_token ?? tokens.refreshToken,
        tokenExpiry: refreshed.credentials.expiry_date
          ? Math.floor(refreshed.credentials.expiry_date / 1000)
          : tokens.tokenExpiry,
      };
      const encrypted = encryptTokenSet(refreshedTokens, deps);
      await deps.store.upsert({
        connectedEmail: stored.connectedEmail,
        scope: stored.scope,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
      });

      return { accessToken: refreshedTokens.accessToken };
    },
  };
}

export type CloudConnectionServices = ReturnType<typeof createCloudConnectionServices>;
