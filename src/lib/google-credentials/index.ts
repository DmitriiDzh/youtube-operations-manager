/**
 * Google OAuth credential resolution/refresh for a stored user (architecture audit 2026-10-01, M1):
 * moved verbatim out of `video-metadata/adapters/google-auth.ts`, where 9 other modules had to
 * deep-import a feature's adapter to reach it. That old path re-exports this module unchanged.
 */
import { createGoogleOAuthClient } from "@/lib/auth";
import {
  getUserOAuthTokens,
  saveUserOAuthTokens,
  type StoredOAuthToken,
} from "@/lib/db";
import {
  DomainError,
  type CredentialRef,
  type ResolvedCredentials,
} from "@/lib/shared-domain";
import {
  authRefreshTokenMissing,
  authScopeInsufficient,
  authUserNotFound,
} from "@/lib/cli-auth/contracts";

type ResolveCredentialDependencies = {
  createOAuthClient: typeof createGoogleOAuthClient;
  getUserTokens: typeof getUserOAuthTokens;
  saveUserTokens: typeof saveUserOAuthTokens;
};

function parseScopeSet(scope?: string | null) {
  if (!scope) return new Set<string>();
  return new Set(scope.split(/\s+/).map((entry) => entry.trim()).filter(Boolean));
}

function assertRequiredScopes(
  scopeSet: Set<string>,
  requiredScopes: readonly string[]
) {
  if (requiredScopes.length === 0) return;

  const missing = requiredScopes.filter((scope) => !scopeSet.has(scope));
  if (missing.length > 0) {
    throw authScopeInsufficient(missing);
  }
}

async function refreshScopeSet(
  oauth2: ReturnType<typeof createGoogleOAuthClient>,
  accessToken: string,
  fallbackScopeSet: Set<string>
) {
  try {
    const tokenInfo = await oauth2.getTokenInfo(accessToken);
    return parseScopeSet(tokenInfo.scopes?.join(" "));
  } catch {
    return fallbackScopeSet;
  }
}

function buildFromStoredUser(
  user: StoredOAuthToken,
  fallbackScopeSet: Set<string>
): ResolvedCredentials {
  if (!user.accessToken) {
    throw new DomainError({
      code: "unauthorized",
      message: "User has no access token stored",
      details: { userId: user.userId },
    });
  }

  return {
    credentialRef: { userId: user.userId },
    accessToken: user.accessToken,
    refreshToken: user.refreshToken ?? undefined,
    tokenExpiry: user.tokenExpiry ?? undefined,
    scopeSet: fallbackScopeSet,
  };
}


/** A token with less than this left is refreshed before use. */
export const TOKEN_EXPIRY_MARGIN_SECONDS = 60;
export function createGoogleCredentialResolver(
  deps: ResolveCredentialDependencies = {
    createOAuthClient: createGoogleOAuthClient,
    getUserTokens: getUserOAuthTokens,
    saveUserTokens: saveUserOAuthTokens,
  }
) {
  return async function resolveGoogleCredentials(args: {
    credentialRef: CredentialRef;
    requiredScopes: readonly string[];
  }): Promise<ResolvedCredentials> {
    const oauth2 = deps.createOAuthClient();

  let resolved: ResolvedCredentials;

    if ("userId" in args.credentialRef) {
      const user = await deps.getUserTokens(args.credentialRef.userId);
      if (!user) {
        throw authUserNotFound("User not found for credential resolution", {
          userId: args.credentialRef.userId,
        });
      }

      resolved = buildFromStoredUser(user, parseScopeSet(user.scope));
    } else {
      resolved = {
        credentialRef: args.credentialRef,
        accessToken: args.credentialRef.accessToken,
        refreshToken: args.credentialRef.refreshToken,
        tokenExpiry: args.credentialRef.tokenExpiry,
        scopeSet: parseScopeSet(args.credentialRef.scope),
      };
    }

    oauth2.setCredentials({
      access_token: resolved.accessToken,
      refresh_token: resolved.refreshToken,
      expiry_date: resolved.tokenExpiry ? resolved.tokenExpiry * 1000 : undefined,
    });

    resolved.scopeSet = await refreshScopeSet(oauth2, resolved.accessToken, resolved.scopeSet);

  const now = Math.floor(Date.now() / 1000);
  // A token about to expire counts as expired (review, 2026-10-20): a streamed upload such as thumbnails.set is not retried by
  // the library after a 401, so a token with seconds left must be refreshed before it is handed out.
  const isExpired = typeof resolved.tokenExpiry === "number" && resolved.tokenExpiry <= now + TOKEN_EXPIRY_MARGIN_SECONDS;

    if (isExpired) {
      if (!resolved.refreshToken) {
        throw authRefreshTokenMissing({
          message: "Access token expired and refresh token is missing",
          credentialRef: args.credentialRef,
        });
      }

      try {
        const refreshed = await oauth2.refreshAccessToken();
        const credentials = refreshed.credentials;

        resolved.accessToken = credentials.access_token ?? resolved.accessToken;
        resolved.refreshToken = credentials.refresh_token ?? resolved.refreshToken;
        resolved.tokenExpiry = credentials.expiry_date
          ? Math.floor(credentials.expiry_date / 1000)
          : resolved.tokenExpiry;
        resolved.scopeSet = await refreshScopeSet(oauth2, resolved.accessToken, resolved.scopeSet);

        if ("userId" in args.credentialRef) {
          await deps.saveUserTokens(args.credentialRef.userId, {
            accessToken: resolved.accessToken,
            refreshToken: resolved.refreshToken,
            tokenExpiry: resolved.tokenExpiry,
            scope: [...resolved.scopeSet].join(" "),
          });
        }
      } catch {
        throw new DomainError({
          code: "unauthorized",
          message: "Access token refresh failed",
        });
      }
    }

    assertRequiredScopes(resolved.scopeSet, args.requiredScopes);
    return resolved;
  };
}

export const resolveGoogleCredentials = createGoogleCredentialResolver();
