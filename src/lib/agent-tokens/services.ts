import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AGENT_TOKEN_PREFIX, DomainError } from "./contracts";
import type { AgentTokenBinding, AgentTokenSummary, IssuedAgentToken } from "./contracts";
import { importAgentTokenInputSchema, issueAgentTokenInputSchema, parseWithSchema, revokeAgentTokenInputSchema } from "./schemas";

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
  /** Active or revoked (BL-130 import must tell the two apart); `revokedAt` null = active. */
  findByHash(tokenHash: string): Promise<(StoredAgentTokenRow & { revokedAt: Date | null }) | null>;
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

/**
 * BL-130 (`docs/roadmap/plans/AGENT_TOKEN_IMPORT_PLAN.md` §2.2): a channel token embeds its channel id,
 * `ytom_ch_<channelId>.<secret>`. YouTube channel ids and base64url never contain `.`, so the first `.`
 * is the separator. A token without one is a legacy token issued before this format.
 */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The channel id embedded in a token, or null for a legacy (pre-BL-130) token. */
function embeddedChannelId(token: string): string | null {
  const body = token.slice(AGENT_TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  return dot === -1 ? null : body.slice(0, dot);
}

function toSummary(row: StoredAgentTokenRow): AgentTokenSummary {
  return { tokenId: row.id, channelId: row.channelId, label: row.label, createdAt: row.createdAt.toISOString() };
}

export function createAgentTokenServices(deps: ServiceDependencies) {
  const generateSecret = deps.generateSecret ?? (() => randomBytes(32).toString("base64url"));

  /**
   * The Google identity connected to `channelId` on this device, verified to own that channel live
   * (not just by the stored `connected_user_id`). Shared by issue and import (AC-P12-11, AC-TI-03).
   */
  async function requireLiveOwner(channelId: string): Promise<string> {
    const userId = await deps.getChannelConnectedUserId(channelId);
    if (!userId) {
      throw new DomainError({
        code: "AGENT_TOKEN_CHANNEL_NOT_CONNECTED",
        message: "channelId is not one of this installation's connected channels",
        details: { channelId },
      });
    }
    const liveChannelId = await deps.getLiveChannelIdForUser(userId);
    if (liveChannelId !== channelId) {
      throw new DomainError({
        code: "AGENT_TOKEN_IDENTITY_MISMATCH",
        message: "the channel's connected Google identity does not currently own this channel -- reconnect the channel first",
        details: { channelId },
      });
    }
    return userId;
  }

  return {
    /**
     * Operator-only. Issues a token bound to `channelId` and to the Google identity that owns that
     * channel RIGHT NOW (verified live, not just by the stored `connected_user_id`). Any previous
     * token of the channel is revoked in the same transaction (one agent = one channel).
     */
    async issueToken(input: unknown): Promise<IssuedAgentToken> {
      const parsed = parseWithSchema(issueAgentTokenInputSchema, input, "issue agent token input");
      // The embedded-id format relies on the id never containing `.` (true for every YouTube id); fail
      // closed at issue rather than mint a token that `verifyToken` would then reject on every call.
      if (!CHANNEL_ID_PATTERN.test(parsed.channelId)) {
        throw new DomainError({
          code: "validation_failed",
          message: "channelId has characters a channel token cannot carry",
          details: { channelId: parsed.channelId },
        });
      }
      const userId = await requireLiveOwner(parsed.channelId);

      const token = `${AGENT_TOKEN_PREFIX}${parsed.channelId}.${generateSecret()}`;
      const id = randomUUID();
      const label = parsed.label && parsed.label.length > 0 ? parsed.label : null;
      await deps.store.replace({ id, channelId: parsed.channelId, userId, tokenHash: hashAgentToken(token), label });
      return { tokenId: id, channelId: parsed.channelId, label, createdAt: new Date().toISOString(), token };
    },

    /**
     * Operator-only (BL-130). Registers on THIS device a token already issued on another one, so one
     * agent configuration works on every device. Same checks as issuing; the plaintext never leaves
     * this function (errors never carry it) and only its hash is stored. Like issuing, it revokes the
     * channel's previous active token here. Re-importing the active token is a no-op; a token this
     * device revoked is refused, never re-activated. Revocation stays per device.
     */
    async importToken(input: unknown): Promise<AgentTokenSummary> {
      const parsed = parseWithSchema(importAgentTokenInputSchema, input, "import agent token input");
      const token = parsed.token.trim();
      const malformed = () =>
        new DomainError({ code: "AGENT_TOKEN_IMPORT_MALFORMED", message: "this is not a channel agent token (ytom_ch_...)" });
      if (!token.startsWith(AGENT_TOKEN_PREFIX) || token.length > 200) throw malformed();
      const embedded = embeddedChannelId(token);
      if (embedded === null) {
        if (SECRET_PATTERN.test(token.slice(AGENT_TOKEN_PREFIX.length))) {
          throw new DomainError({
            code: "AGENT_TOKEN_IMPORT_LEGACY_FORMAT",
            message: "this token was issued before tokens carried their channel -- issue a new one on the source device and import that",
          });
        }
        throw malformed();
      }
      const secret = token.slice(AGENT_TOKEN_PREFIX.length + embedded.length + 1);
      if (!CHANNEL_ID_PATTERN.test(embedded) || !SECRET_PATTERN.test(secret)) throw malformed();
      if (embedded !== parsed.channelId) {
        throw new DomainError({
          code: "AGENT_TOKEN_CHANNEL_MISMATCH",
          message: "this token belongs to another channel",
          details: { channelId: parsed.channelId, tokenChannelId: embedded },
        });
      }

      const userId = await requireLiveOwner(parsed.channelId);
      const tokenHash = hashAgentToken(token);
      const existing = await deps.store.findByHash(tokenHash);
      if (existing) {
        if (existing.revokedAt !== null) {
          throw new DomainError({
            code: "AGENT_TOKEN_IMPORT_REVOKED",
            message: "this token was revoked on this device and cannot be used here again -- issue a new one",
          });
        }
        if (existing.channelId !== parsed.channelId) {
          throw new DomainError({ code: "AGENT_TOKEN_CHANNEL_MISMATCH", message: "this token belongs to another channel" });
        }
        return toSummary(existing);
      }
      const label = parsed.label && parsed.label.length > 0 ? parsed.label : null;
      const id = randomUUID();
      await deps.store.replace({ id, channelId: parsed.channelId, userId, tokenHash, label });
      return { tokenId: id, channelId: parsed.channelId, label, createdAt: new Date().toISOString() };
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
      // BL-130, defense in depth (AC-TI-09): a token that names a channel is valid only for that
      // channel's row. A legacy token (no embedded channel) is verified exactly as before.
      const embedded = embeddedChannelId(token);
      if (embedded !== null && embedded !== row.channelId) throw invalid();
      // Review round 2: a token is only as valid as the channel connection it was issued for. A
      // channel disconnected (or reconnected under another Google identity) since issue invalidates
      // it immediately -- checked on every verification, including MCP's per-call re-verification.
      if ((await deps.getChannelConnectedUserId(row.channelId)) !== row.userId) throw invalid();
      return { tokenId: row.id, channelId: row.channelId, userId: row.userId };
    },
  };
}

export type AgentTokenServices = ReturnType<typeof createAgentTokenServices>;
