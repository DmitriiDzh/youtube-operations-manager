import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DomainError } from "./contracts";
import type { IssuedRoleToken, RoleTokenBinding, RoleTokenKind, RoleTokenSummary } from "./contracts";
import { importRoleTokenInputSchema, issueRoleTokenInputSchema, parseWithSchema } from "./schemas";

export type StoredRoleTokenRow = { id: string; label: string | null; createdAt: Date };

export type RoleTokenStore = {
  /** Revokes the active token (if any) and inserts the new one atomically. */
  replace(input: { id: string; tokenHash: string; label: string | null }): Promise<void>;
  revoke(): Promise<number>;
  findActiveByHash(tokenHash: string): Promise<StoredRoleTokenRow | null>;
  /** Active or revoked (BL-130 import must tell the two apart); `revokedAt` null = active. */
  findByHash(tokenHash: string): Promise<(StoredRoleTokenRow & { revokedAt: Date | null }) | null>;
  listActive(): Promise<StoredRoleTokenRow[]>;
};

export type RoleTokenServiceDependencies = {
  kind: RoleTokenKind;
  store: RoleTokenStore;
  /** Injectable for tests; defaults to 32 random bytes. */
  generateSecret?: () => string;
};

/** SHA-256 hex of the full token string. */
export function hashRoleToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A label is stored and shown in plaintext: refuse one that looks like a token pasted in the wrong field. */
function rejectTokenLikeLabel(label: string | undefined): void {
  if (label && /^ytom_/i.test(label.trim())) {
    throw new DomainError({ code: "validation_failed", message: "label must not be a token" });
  }
}

/** BL-130: what `issueToken` generates after the prefix -- base64url of 32 random bytes. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function toSummary(row: StoredRoleTokenRow): RoleTokenSummary {
  return { tokenId: row.id, label: row.label, createdAt: row.createdAt.toISOString() };
}

export function createRoleTokenServices(deps: RoleTokenServiceDependencies) {
  const { prefix, name } = deps.kind;
  const generateSecret = deps.generateSecret ?? (() => randomBytes(32).toString("base64url"));

  return {
    /**
     * Operator-only. Issues the role's token. Any previous token is revoked in the same transaction (one active token at a
     * time). The token binds to no channel and no identity.
     */
    async issueToken(input: unknown): Promise<IssuedRoleToken> {
      const parsed = parseWithSchema(issueRoleTokenInputSchema, input ?? {}, `issue ${name} token input`);
      rejectTokenLikeLabel(parsed.label);
      const token = `${prefix}${generateSecret()}`;
      const id = randomUUID();
      const label = parsed.label && parsed.label.length > 0 ? parsed.label : null;
      await deps.store.replace({ id, tokenHash: hashRoleToken(token), label });
      return { tokenId: id, label, createdAt: new Date().toISOString(), token };
    },

    /**
     * Operator-only (BL-130). Registers on THIS device a token of this role already issued on another one. The plaintext never
     * leaves this function (errors never carry it); only its hash is stored. Like issuing, it revokes the previous active token
     * here. Re-importing the active token is a no-op; a revoked token is refused, never re-activated.
     */
    async importToken(input: unknown): Promise<RoleTokenSummary> {
      const parsed = parseWithSchema(importRoleTokenInputSchema, input, `import ${name} token input`);
      const token = parsed.token.trim();
      if (!token.startsWith(prefix) || !SECRET_PATTERN.test(token.slice(prefix.length))) {
        throw new DomainError({ code: "AGENT_TOKEN_IMPORT_MALFORMED", message: `this is not a ${name} token (${prefix}...)` });
      }
      rejectTokenLikeLabel(parsed.label);
      const tokenHash = hashRoleToken(token);
      const existingOutcome = (existing: (StoredRoleTokenRow & { revokedAt: Date | null }) | null): RoleTokenSummary | null => {
        if (!existing) return null;
        if (existing.revokedAt !== null) {
          throw new DomainError({
            code: "AGENT_TOKEN_IMPORT_REVOKED",
            message: "this token was revoked on this device and cannot be used here again -- issue a new one",
          });
        }
        return toSummary(existing);
      };
      const known = existingOutcome(await deps.store.findByHash(tokenHash));
      if (known) return known;
      const label = parsed.label && parsed.label.length > 0 ? parsed.label : null;
      const id = randomUUID();
      try {
        await deps.store.replace({ id, tokenHash, label });
      } catch (error) {
        // A concurrent import of the same token won the UNIQUE race; report the winner's row.
        const raced = existingOutcome(await deps.store.findByHash(tokenHash));
        if (raced) return raced;
        throw error;
      }
      return { tokenId: id, label, createdAt: new Date().toISOString() };
    },

    /** Operator-only. Revokes the active token; idempotent. Never touches any other role's or any channel's token. */
    async revokeToken(): Promise<{ revoked: number }> {
      return { revoked: await deps.store.revoke() };
    },

    /** Operator-only status -- metadata only, never the token or its hash. `null` when none is active. */
    async getActiveToken(): Promise<RoleTokenSummary | null> {
      const rows = await deps.store.listActive();
      return rows.length > 0 ? toSummary(rows[0]) : null;
    },

    /**
     * Verifies a presented token. Returns the binding, or throws `AGENT_TOKEN_INVALID` for a missing, malformed, wrong-prefix
     * (including another role's or a channel's token), unknown, or revoked token -- deliberately one indistinguishable error.
     */
    async verifyToken(token: string | null | undefined): Promise<RoleTokenBinding> {
      const invalid = () => new DomainError({ code: "AGENT_TOKEN_INVALID", message: "agent token is missing, unknown, or revoked" });
      if (typeof token !== "string" || !token.startsWith(prefix) || token.length > 200) {
        throw invalid();
      }
      const row = await deps.store.findActiveByHash(hashRoleToken(token));
      if (!row) throw invalid();
      return { tokenId: row.id };
    },
  };
}

export type RoleTokenServices = ReturnType<typeof createRoleTokenServices>;
