import { DomainError } from "@/lib/video-metadata/contracts";
import type { OAuthUserSummary } from "@/lib/db";
import type { WriteChannelContext } from "@/lib/write-context/contracts";

export type AuthUserSummary = OAuthUserSummary & { isActive: boolean };

export type SelectUserResult = {
  activeUser: AuthUserSummary;
  previousActiveUserId: string | null;
  changed: boolean;
  effectiveCredentialRef: { userId: string };
  writeChannel: WriteChannelContext;
  activeWriteChannel: WriteChannelContext["activeWriteChannel"];
  selectedChannelId: string | null;
  alignment: WriteChannelContext["alignment"];
  requiresReauth: boolean;
  affectsRemoteOAuth: false;
};

export function authCallbackInvalid(message: string, details?: unknown) {
  return new DomainError({
    code: "AUTH_CALLBACK_INVALID",
    message,
    details,
  });
}

export function authRefreshTokenMissing(details?: unknown) {
  return new DomainError({
    code: "AUTH_REFRESH_TOKEN_MISSING",
    message: "Refresh token is missing for the requested operation",
    details,
  });
}

export function authUserNotFound(message: string, details?: unknown) {
  return new DomainError({
    code: "AUTH_USER_NOT_FOUND",
    message,
    details,
  });
}

export function authScopeInsufficient(missingScopes: string[]) {
  return new DomainError({
    code: "AUTH_SCOPE_INSUFFICIENT",
    message: "Credentials are missing required OAuth scopes",
    details: { missingScopes },
  });
}
