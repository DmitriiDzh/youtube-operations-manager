import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AGENT_TOKEN_PREFIX, DomainError } from "./contracts";
import type { AgentTokenBinding, AgentTokenSummary, IssuedAgentToken } from "./contracts";
import { issueAgentTokenInputSchema, parseWithSchema, revokeAgentTokenInputSchema } from "./schemas";

export type StoredAgentTokenRow = {
  id: string;
  channelId: string;
  userId: string;
  label: string | null;
  createdAt: Date;
};

export type AgentTokenStore = {
  /** Revokes the channel's active token(s) and inserts the new one atomically. */
  replace(input: { id: string; channelId: string; userId: string; tokenHash: string; label: string | null }): Promise<void>;
  revokeForChannel(channelId: string): Promise<number>;
  findActiveByHash(tokenHash: string): Promise<StoredAgentTokenRow | null>;
  listActive(): Promise<StoredAgentTokenRow[]>;
};

export type ServiceDependencies = {
  store: AgentTokenStore;
  /** The Google identity currently recorded as connected to the channel, or null if not connected. */
  getChannelConnectedUserId(channelId: string): Promise<string | null>;
  /** The channel that identity's live OAuth credentials actually own right now (`channels.list mine`). */
  getLiveChannelIdForUser(userId: string): Promise<string | null>;
  /** Injectable for tests; defaults to 32 random bytes. */
  generateSecret?: () => string;
};

/** SHA-256 hex of the full token string. Exported so tests can state expected hashes independently. */
export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function toSummary(row: StoredAgentTokenRow): AgentTokenSummary {
  return { tokenId: row.id, channelId: row.channelId, label: row.label, createdAt: row.createdAt.toISOString() };
}

export function createAgentTokenServices(deps: ServiceDependencies) {
  const generateSecret = deps.generateSecret ?? (() => randomBytes(32).toString("base64url"));

  return {
    /**
     * Operator-only. Issues a token bound to `channelId` and to the Google identity that owns that
     * channel RIGHT NOW (verified live, not just by the stored `connected_user_id`). Any previous
     * token of the channel is revoked in the same transaction (one agent = one channel).
     */
    async issueToken(input: unknown): Promise<IssuedAgentToken> {
      const parsed = parseWithSchema(issueAgentTokenInputSchema, input, "issue agent token input");
      const userId = await deps.getChannelConnectedUserId(parsed.channelId);
      if (!userId) {
        throw new DomainError({
          code: "AGENT_TOKEN_CHANNEL_NOT_CONNECTED",
          message: "channelId is not one of this installation's connected channels",
          details: { channelId: parsed.channelId },
        });
      }
      const liveChannelId = await deps.getLiveChannelIdForUser(userId);
      if (liveChannelId !== parsed.channelId) {
        throw new DomainError({
          code: "AGENT_TOKEN_IDENTITY_MISMATCH",
          message: "the channel's connected Google identity does not currently own this channel -- reconnect the channel first",
          details: { channelId: parsed.channelId },
        });
      }

      const token = `${AGENT_TOKEN_PREFIX}${generateSecret()}`;
      const id = randomUUID();
      const label = parsed.label && parsed.label.length > 0 ? parsed.label : null;
      await deps.store.replace({ id, channelId: parsed.channelId, userId, tokenHash: hashAgentToken(token), label });
      return { tokenId: id, channelId: parsed.channelId, label, createdAt: new Date().toISOString(), token };
    },

    /** Operator-only. Revokes the channel's active token; idempotent. */
    async revokeToken(input: unknown): Promise<{ revoked: number }> {
      const parsed = parseWithSchema(revokeAgentTokenInputSchema, input, "revoke agent token input");
      return { revoked: await deps.store.revokeForChannel(parsed.channelId) };
    },

    /** Operator-only listing -- metadata only, never the token or its hash. */
    async listActiveTokens(): Promise<AgentTokenSummary[]> {
      return (await deps.store.listActive()).map(toSummary);
    },

    /**
     * Verifies a presented token. Returns the binding, or throws `AGENT_TOKEN_INVALID` for a
     * missing, malformed, unknown, or revoked token -- deliberately one indistinguishable error.
     */
    async verifyToken(token: string | null | undefined): Promise<AgentTokenBinding> {
      const invalid = () => new DomainError({ code: "AGENT_TOKEN_INVALID", message: "agent token is missing, unknown, or revoked" });
      if (typeof token !== "string" || !token.startsWith(AGENT_TOKEN_PREFIX) || token.length > 200) {
        throw invalid();
      }
      const row = await deps.store.findActiveByHash(hashAgentToken(token));
      if (!row) throw invalid();
      return { tokenId: row.id, channelId: row.channelId, userId: row.userId };
    },
  };
}

export type AgentTokenServices = ReturnType<typeof createAgentTokenServices>;
