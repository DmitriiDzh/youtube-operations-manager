import {
  buildGoogleLoopbackAuthUrl,
  exchangeGoogleAuthCode,
  fetchGoogleIdentity,
  generateOAuthState,
  generatePkcePair,
  pollGoogleDeviceAuthorizationToken,
  revokeGoogleToken,
  startGoogleDeviceAuthorization,
  YOUTUBE_READ_SCOPE,
  type DeviceAuthorizationStart,
  type GoogleIdentity,
  type OAuthTokenSet,
} from "@/lib/auth";
import {
  clearUserOAuthTokens,
  getSelectedChannelId,
  setSelectedChannelId,
  getOAuthUserSummary,
  getUserOAuthTokens,
  listOAuthUsers,
  upsertOAuthUserFromCli,
  type OAuthUserSummary,
} from "@/lib/db";
import { createWriteContextCore, type WriteChannelContext } from "@/lib/write-context";
import type { CredentialRef, ResolvedCredentials } from "@/lib/shared-domain";
import { DomainError } from "@/lib/shared-domain";
import { getAgentSession } from "@/lib/agent-session";
import { resolveGoogleCredentials } from "@/lib/google-credentials";
import { authUserNotFound, type AuthUserSummary, type SelectUserResult } from "./contracts";
import { selectWriteChannelInputSchema, selectUserInputSchema, toValidationIssues } from "./schemas";
import { createActiveAuthStorage, type ActiveAuthStorage } from "./adapters/active-auth-storage";
import { defaultOpenBrowser } from "./adapters/browser";
import { createLoopbackCallbackServer, type LoopbackCallbackResult } from "./adapters/loopback-callback-server";

type CliAuthServiceDependencies = {
  storage: ActiveAuthStorage;
  openBrowser: (url: string) => Promise<void>;
  oauth: {
    generateState: () => string;
    generatePkcePair: () => { verifier: string; challenge: string };
    buildLoopbackAuthUrl: typeof buildGoogleLoopbackAuthUrl;
    exchangeAuthCode: typeof exchangeGoogleAuthCode;
    fetchIdentity: typeof fetchGoogleIdentity;
    startDeviceAuthorization: typeof startGoogleDeviceAuthorization;
    pollDeviceAuthorizationToken: typeof pollGoogleDeviceAuthorizationToken;
    revokeToken: typeof revokeGoogleToken;
  };
  credentialResolver: typeof resolveGoogleCredentials;
  writeContext: {
    getWriteChannelContext(args: {
      credentialRef: CredentialRef;
      credentials?: ResolvedCredentials;
      expectedChannelId?: string;
    }): Promise<WriteChannelContext>;
    listKnownChannels(args: {
      credentialRef: CredentialRef;
      credentials?: ResolvedCredentials;
      expectedChannelId?: string;
    }): Promise<{
      knownChannels: WriteChannelContext["knownChannels"];
      alignment: WriteChannelContext["alignment"];
      activeWriteChannel: WriteChannelContext["activeWriteChannel"];
      selectedChannelId: WriteChannelContext["selectedChannelId"];
      expectedChannelId: WriteChannelContext["expectedChannelId"];
      source: WriteChannelContext["source"];
      requiresReauth: WriteChannelContext["requiresReauth"];
    }>;
    selectWriteChannel(args: {
      credentialRef: CredentialRef;
      channelId: string;
      credentials?: ResolvedCredentials;
    }): Promise<{
      selectedChannelId: string | null;
      activeWriteChannel: WriteChannelContext["activeWriteChannel"];
      expectedChannelId: string | null;
      source: WriteChannelContext["source"];
      alignment: WriteChannelContext["alignment"];
      knownChannels: WriteChannelContext["knownChannels"];
      requiresReauth: boolean;
      message: string;
      recommendedAction: string | null;
    }>;
  };
  db: {
    upsertUser: typeof upsertOAuthUserFromCli;
    listUsers: typeof listOAuthUsers;
    getUserSummary: typeof getOAuthUserSummary;
    getUserTokens: typeof getUserOAuthTokens;
    clearUserTokens: typeof clearUserOAuthTokens;
    getSelectedChannelId: typeof getSelectedChannelId;
    setSelectedChannelId: typeof setSelectedChannelId;
  };
  startLoopbackCallbackServer: (args: {
    expectedState: string;
    timeoutMs: number;
  }) => Promise<{ redirectUri: string; waitForCallback: Promise<LoopbackCallbackResult> }>;
};

function toAuthUserSummary(
  user: OAuthUserSummary,
  activeUserId: string | null
): AuthUserSummary {
  return {
    ...user,
    isActive: activeUserId === user.userId,
  };
}

function fallbackWriteChannelContext(args: {
  selectedChannelId: string | null;
  reason: "auth_unavailable";
}): WriteChannelContext {
  const requiresReauth = args.selectedChannelId !== null;
  return {
    activeWriteChannel: null,
    selectedChannelId: args.selectedChannelId,
    expectedChannelId: args.selectedChannelId,
    source: args.selectedChannelId ? "stored" : "missing",
    knownChannels: args.selectedChannelId
      ? [
          {
            id: args.selectedChannelId,
            title: null,
            source: "selected",
            isActive: false,
            isSelected: true,
          },
        ]
      : [],
    alignment: {
      status: "unresolved",
      requiresReauth,
      message:
        args.reason === "auth_unavailable"
          ? "Cannot resolve active OAuth channel with current credentials."
          : "Write channel alignment is unresolved.",
      recommendedAction: args.selectedChannelId
        ? "Reauthenticate with the selected channel and retry."
        : "Authenticate and select an expected write channel.",
    },
    requiresReauth,
  };
}

async function persistAuthenticatedUser(args: {
  identity: GoogleIdentity;
  tokens: OAuthTokenSet;
  deps: CliAuthServiceDependencies;
}) {
  await args.deps.db.upsertUser({
    userId: args.identity.userId,
    email: args.identity.email,
    name: args.identity.name,
    image: args.identity.image,
    accessToken: args.tokens.accessToken,
    refreshToken: args.tokens.refreshToken,
    tokenExpiry: args.tokens.tokenExpiry,
    scope: args.tokens.scope,
  });

  await args.deps.storage.write({ activeUserId: args.identity.userId });
}

export function createCliAuthService(
  deps: Partial<CliAuthServiceDependencies> = {}
) {
  const resolvedDeps: CliAuthServiceDependencies = {
    storage: deps.storage ?? createActiveAuthStorage(),
    openBrowser: deps.openBrowser ?? defaultOpenBrowser,
    oauth: deps.oauth ?? {
      generateState: generateOAuthState,
      generatePkcePair,
      buildLoopbackAuthUrl: buildGoogleLoopbackAuthUrl,
      exchangeAuthCode: exchangeGoogleAuthCode,
      fetchIdentity: fetchGoogleIdentity,
      startDeviceAuthorization: startGoogleDeviceAuthorization,
      pollDeviceAuthorizationToken: pollGoogleDeviceAuthorizationToken,
      revokeToken: revokeGoogleToken,
    },
    credentialResolver: deps.credentialResolver ?? resolveGoogleCredentials,
    writeContext: deps.writeContext ?? createWriteContextCore(),
    db: deps.db ?? {
      upsertUser: upsertOAuthUserFromCli,
      listUsers: listOAuthUsers,
      getUserSummary: getOAuthUserSummary,
      getUserTokens: getUserOAuthTokens,
      clearUserTokens: clearUserOAuthTokens,
      getSelectedChannelId,
      setSelectedChannelId,
    },
    startLoopbackCallbackServer: deps.startLoopbackCallbackServer ?? createLoopbackCallbackServer,
  };

  // Phase 12 (AC-P12-04): identity/session-switching and identity-enumerating operations are
  // operator-only. Defense in depth -- the MCP registry and CLI dispatch already never expose them
  // in an agent session; this makes the service itself refuse too.
  function assertNotAgentSession(): void {
    if (getAgentSession()) {
      throw new DomainError({
        code: "AGENT_SESSION_OPERATOR_ONLY",
        message: "this action is operator-only and unavailable in a channel-bound agent session",
      });
    }
  }

  async function resolveEffectiveCredentialRef(args: {
    explicit?: CredentialRef;
  }): Promise<CredentialRef> {
    // Phase 12 (docs/roadmap/plans/PHASE_12_PLAN.md §6, AC-P12-05): a channel-bound agent process
    // always acts as the identity recorded on its token -- never a caller-supplied ref, and never
    // the device-global auth-context.json.
    const agentSession = getAgentSession();
    if (agentSession) {
      if (args.explicit) {
        throw new DomainError({
          code: "AGENT_SESSION_CREDENTIAL_OVERRIDE",
          message: "an agent session cannot supply its own credentials; it always acts as its channel's identity",
        });
      }
      return { userId: agentSession.userId };
    }

    if (args.explicit) {
      return args.explicit;
    }

    const context = await resolvedDeps.storage.read();
    if (!context) {
      throw authUserNotFound("No active auth context. Run `auth login` first.", {
        reason: "active_user_missing",
      });
    }

    const user = await resolvedDeps.db.getUserSummary(context.activeUserId);
    if (!user) {
      throw authUserNotFound("Active auth user does not exist in local storage", {
        userId: context.activeUserId,
      });
    }

    return { userId: user.userId };
  }

  async function resolveWriteChannelSnapshot(args: {
    effectiveCredentialRef: { userId: string };
  }): Promise<{ writeChannel: WriteChannelContext; selectedChannelId: string | null }> {
    const selectedChannelId = await resolvedDeps.db.getSelectedChannelId(args.effectiveCredentialRef.userId);

    let credentials: ResolvedCredentials | undefined;
    try {
      credentials = await resolvedDeps.credentialResolver({
        credentialRef: args.effectiveCredentialRef,
        requiredScopes: [YOUTUBE_READ_SCOPE],
      });
    } catch {
      credentials = undefined;
    }

    if (credentials) {
      return {
        writeChannel: await resolvedDeps.writeContext.getWriteChannelContext({
          credentialRef: args.effectiveCredentialRef,
          credentials,
        }),
        selectedChannelId,
      };
    }

    return {
      writeChannel: fallbackWriteChannelContext({
        selectedChannelId,
        reason: "auth_unavailable",
      }),
      selectedChannelId,
    };
  }

  return {
    resolveEffectiveCredentialRef,

    async login(args?: { timeoutMs?: number }) {
      assertNotAgentSession();
      const timeoutMs = args?.timeoutMs ?? 120_000;
      const state = resolvedDeps.oauth.generateState();
      const pkce = resolvedDeps.oauth.generatePkcePair();

      const callbackServer = await resolvedDeps.startLoopbackCallbackServer({
        expectedState: state,
        timeoutMs,
      });

      const authUrl = resolvedDeps.oauth.buildLoopbackAuthUrl({
        redirectUri: callbackServer.redirectUri,
        state,
        codeChallenge: pkce.challenge,
      });

      await resolvedDeps.openBrowser(authUrl);
      const callback = await callbackServer.waitForCallback;

      const tokenSet = await resolvedDeps.oauth.exchangeAuthCode({
        redirectUri: callbackServer.redirectUri,
        code: callback.code,
        codeVerifier: pkce.verifier,
      });

      const identity = await resolvedDeps.oauth.fetchIdentity({
        accessToken: tokenSet.accessToken,
        idToken: tokenSet.idToken,
      });

      await persistAuthenticatedUser({
        identity,
        tokens: tokenSet,
        deps: resolvedDeps,
      });

      const summary = await resolvedDeps.db.getUserSummary(identity.userId);
      if (!summary) {
        throw authUserNotFound("Authenticated user could not be persisted", {
          userId: identity.userId,
        });
      }

      return {
        method: "loopback" as const,
        user: toAuthUserSummary(summary, identity.userId),
      };
    },

    async loginDevice(args?: { onPending?: (data: DeviceAuthorizationStart) => void }) {
      assertNotAgentSession();
      const start = await resolvedDeps.oauth.startDeviceAuthorization();
      args?.onPending?.(start);

      const tokenSet = await resolvedDeps.oauth.pollDeviceAuthorizationToken({
        deviceCode: start.deviceCode,
        intervalSeconds: start.interval,
        expiresInSeconds: start.expiresIn,
      });

      const identity = await resolvedDeps.oauth.fetchIdentity({
        accessToken: tokenSet.accessToken,
        idToken: tokenSet.idToken,
      });

      await persistAuthenticatedUser({
        identity,
        tokens: tokenSet,
        deps: resolvedDeps,
      });

      const summary = await resolvedDeps.db.getUserSummary(identity.userId);
      if (!summary) {
        throw authUserNotFound("Authenticated user could not be persisted", {
          userId: identity.userId,
        });
      }

      return {
        method: "device" as const,
        user: toAuthUserSummary(summary, identity.userId),
        verification: {
          verificationUrl: start.verificationUrl,
          verificationUrlComplete: start.verificationUrlComplete,
          userCode: start.userCode,
        },
      };
    },

    async whoami() {
      // Phase 12 (PHASE_12_PLAN.md §6, AC-P12-03/05; review round 1): in a channel-bound agent session
      // "who am I" is the token's recorded identity -- auth-context.json (the operator's device-global
      // active user, possibly a different Google identity) is never read.
      const agentSession = getAgentSession();
      let activeUserId: string;
      if (agentSession) {
        activeUserId = agentSession.userId;
      } else {
        const context = await resolvedDeps.storage.read();
        if (!context) {
          throw authUserNotFound("No active auth context. Run `auth login` first.", {
            reason: "active_user_missing",
          });
        }
        activeUserId = context.activeUserId;
      }

      const user = await resolvedDeps.db.getUserSummary(activeUserId);
      if (!user) {
        throw authUserNotFound("Active auth user does not exist in local storage", {
          userId: activeUserId,
        });
      }

      const effectiveCredentialRef = { userId: user.userId };
      const { writeChannel } = await resolveWriteChannelSnapshot({
        effectiveCredentialRef,
      });

      return {
        ...toAuthUserSummary(user, activeUserId),
        activeWriteChannel: writeChannel.activeWriteChannel,
        selectedChannelId: writeChannel.selectedChannelId,
        alignment: writeChannel.alignment,
        requiresReauth: writeChannel.requiresReauth,
        knownChannels: writeChannel.knownChannels,
        writeChannel,
        effectiveCredentialRef,
      };
    },

    async selectUser(args: { userId: string }): Promise<SelectUserResult> {
      assertNotAgentSession();
      const parsed = selectUserInputSchema.safeParse(args);
      if (!parsed.success) {
        throw new DomainError({
          code: "validation_failed",
          message: "Invalid user selection input",
          details: toValidationIssues(parsed.error),
        });
      }

      const nextUser = await resolvedDeps.db.getUserSummary(parsed.data.userId);
      if (!nextUser) {
        throw authUserNotFound("Requested auth user does not exist in local storage", {
          userId: parsed.data.userId,
          affectsRemoteOAuth: false,
        });
      }

      const previousContext = await resolvedDeps.storage.read();
      const previousActiveUserId = previousContext?.activeUserId ?? null;
      const changed = previousActiveUserId !== nextUser.userId;

      await resolvedDeps.storage.write({ activeUserId: nextUser.userId });

      const effectiveCredentialRef = { userId: nextUser.userId };
      const { writeChannel } = await resolveWriteChannelSnapshot({
        effectiveCredentialRef,
      });

      return {
        activeUser: toAuthUserSummary(nextUser, nextUser.userId),
        previousActiveUserId,
        changed,
        effectiveCredentialRef,
        writeChannel,
        activeWriteChannel: writeChannel.activeWriteChannel,
        selectedChannelId: writeChannel.selectedChannelId,
        alignment: writeChannel.alignment,
        requiresReauth: writeChannel.requiresReauth,
        affectsRemoteOAuth: false,
      };
    },

    async listKnownWriteChannels(args?: { credentialRef?: CredentialRef }) {
      assertNotAgentSession();
      const effectiveCredentialRef = await resolveEffectiveCredentialRef({
        explicit: args?.credentialRef,
      });

      const selectedChannelId =
        "userId" in effectiveCredentialRef
          ? await resolvedDeps.db.getSelectedChannelId(effectiveCredentialRef.userId)
          : null;

      let credentials: ResolvedCredentials | undefined;
      try {
        credentials = await resolvedDeps.credentialResolver({
          credentialRef: effectiveCredentialRef,
          requiredScopes: [YOUTUBE_READ_SCOPE],
        });
      } catch {
        credentials = undefined;
      }

      if (!credentials) {
        const fallback = fallbackWriteChannelContext({
          selectedChannelId,
          reason: "auth_unavailable",
        });

        return {
          knownChannels: fallback.knownChannels,
          alignment: fallback.alignment,
          activeWriteChannel: fallback.activeWriteChannel,
          selectedChannelId: fallback.selectedChannelId,
          expectedChannelId: fallback.expectedChannelId,
          source: fallback.source,
          requiresReauth: fallback.requiresReauth,
        };
      }

      return resolvedDeps.writeContext.listKnownChannels({
        credentialRef: effectiveCredentialRef,
        credentials,
      });
    },

    async selectWriteChannel(args: { channelId: string; credentialRef?: CredentialRef }) {
      assertNotAgentSession();
      const parsed = selectWriteChannelInputSchema.safeParse({
        channelId: args.channelId,
        credentialRef: args.credentialRef,
      });

      if (!parsed.success) {
        throw new DomainError({
          code: "validation_failed",
          message: "Invalid write channel selection input",
          details: toValidationIssues(parsed.error),
        });
      }

      const effectiveCredentialRef = await resolveEffectiveCredentialRef({
        explicit: parsed.data.credentialRef as CredentialRef | undefined,
      });

      if (!("userId" in effectiveCredentialRef)) {
        throw new DomainError({
          code: "validation_failed",
          message: "write_channel_select requires userId-based credentialRef",
          details: [
            {
              path: "credentialRef.userId",
              message: "Persisting selected channel requires a local user profile",
              code: "custom",
            },
          ],
        });
      }

      let credentials: ResolvedCredentials | undefined;
      try {
        credentials = await resolvedDeps.credentialResolver({
          credentialRef: effectiveCredentialRef,
          requiredScopes: [YOUTUBE_READ_SCOPE],
        });
      } catch {
        credentials = undefined;
      }

      return resolvedDeps.writeContext.selectWriteChannel({
        credentialRef: effectiveCredentialRef,
        channelId: parsed.data.channelId,
        credentials,
      });
    },

    async listUsers() {
      assertNotAgentSession();
      const context = await resolvedDeps.storage.read();
      const activeUserId = context?.activeUserId ?? null;

      const users = await resolvedDeps.db.listUsers();
      return {
        users: users.map((user) => toAuthUserSummary(user, activeUserId)),
      };
    },

    async logout() {
      assertNotAgentSession();
      await resolvedDeps.storage.clear();
      return { loggedOut: true };
    },

    async revoke(args?: { userId?: string }) {
      assertNotAgentSession();
      let targetUserId = args?.userId;

      if (!targetUserId) {
        const resolved = await resolveEffectiveCredentialRef({ explicit: undefined });
        if (!("userId" in resolved)) {
          throw authUserNotFound("No active user is available for revoke", {
            reason: "active_user_missing",
          });
        }

        targetUserId = resolved.userId;
      }

      const tokenRow = await resolvedDeps.db.getUserTokens(targetUserId);
      if (!tokenRow) {
        throw authUserNotFound("Cannot revoke non-existing user", { userId: targetUserId });
      }

      const tokenForRevoke = tokenRow.refreshToken ?? tokenRow.accessToken;
      if (!tokenForRevoke) {
        throw authUserNotFound("No OAuth token available to revoke for this user", {
          userId: targetUserId,
        });
      }

      await resolvedDeps.oauth.revokeToken(tokenForRevoke);
      await resolvedDeps.db.clearUserTokens(targetUserId);

      const context = await resolvedDeps.storage.read();
      const clearedActive = context?.activeUserId === targetUserId;
      if (clearedActive) {
        await resolvedDeps.storage.clear();
      }

      return {
        revoked: true,
        userId: targetUserId,
        clearedActive,
      };
    },
  };
}

export type CliAuthService = ReturnType<typeof createCliAuthService>;
