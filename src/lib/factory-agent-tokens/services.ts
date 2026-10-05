import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DomainError, FACTORY_AGENT_TOKEN_PREFIX } from "./contracts";
import type { FactoryTokenBinding, FactoryTokenSummary, IssuedFactoryToken } from "./contracts";
import { importFactoryTokenInputSchema, issueFactoryTokenInputSchema, parseWithSchema } from "./schemas";

export type StoredFactoryTokenRow = { id: string; label: string | null; createdAt: Date };

export type FactoryTokenStore = {
  /** Revokes the active token (if any) and inserts the new one atomically. */
  replace(input: { id: string; tokenHash: string; label: string | null }): Promise<void>;
  revoke(): Promise<number>;
  findActiveByHash(tokenHash: string): Promise<StoredFactoryTokenRow | null>;
  /** Active or revoked (BL-130 import must tell the two apart); `revokedAt` null = active. */
  findByHash(tokenHash: string): Promise<(StoredFactoryTokenRow & { revokedAt: Date | null }) | null>;
  listActive(): Promise<StoredFactoryTokenRow[]>;
};

export type ServiceDependencies = {
  store: FactoryTokenStore;
  /** Injectable for tests; defaults to 32 random bytes. */
  generateSecret?: () => string;
};

/** SHA-256 hex of the full token string. Exported so tests can state expected hashes independently. */
export function hashFactoryToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** BL-130: what `issueToken` generates after the prefix -- base64url of 32 random bytes. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function toSummary(row: StoredFactoryTokenRow): FactoryTokenSummary {
  return { tokenId: row.id, label: row.label, createdAt: row.createdAt.toISOString() };
}

export function createFactoryTokenServices(deps: ServiceDependencies) {
  const generateSecret = deps.generateSecret ?? (() => randomBytes(32).toString("base64url"));

  return {
    /**
     * Operator-only. Issues the Factory Operator token. Any previous token is revoked in the same
     * transaction (one active token at a time). The token binds to no channel and no identity.
     */
    async issueToken(input: unknown): Promise<IssuedFactoryToken> {
      const parsed = parseWithSchema(issueFactoryTokenInputSchema, input ?? {}, "issue factory token input");
      const token = `${FACTORY_AGENT_TOKEN_PREFIX}${generateSecret()}`;
      const id = randomUUID();
      const label = parsed.label && parsed.label.length > 0 ? parsed.label : null;
      await deps.store.replace({ id, tokenHash: hashFactoryToken(token), label });
      return { tokenId: id, label, createdAt: new Date().toISOString(), token };
    },

    /**
     * Operator-only (BL-130). Registers on THIS device the factory token already issued on another one.
     * The plaintext never leaves this function (errors never carry it); only its hash is stored. Like
     * issuing, it revokes the previous active factory token here. Re-importing the active token is a
     * no-op; a token this device revoked is refused, never re-activated. Revocation stays per device.
     */
    async importToken(input: unknown): Promise<FactoryTokenSummary> {
      const parsed = parseWithSchema(importFactoryTokenInputSchema, input, "import factory token input");
      const token = parsed.token.trim();
      if (!token.startsWith(FACTORY_AGENT_TOKEN_PREFIX) || !SECRET_PATTERN.test(token.slice(FACTORY_AGENT_TOKEN_PREFIX.length))) {
        throw new DomainError({ code: "AGENT_TOKEN_IMPORT_MALFORMED", message: "this is not a Factory Operator token (ytom_fo_...)" });
      }
      const tokenHash = hashFactoryToken(token);
      const existing = await deps.store.findByHash(tokenHash);
      if (existing) {
        if (existing.revokedAt !== null) {
          throw new DomainError({
            code: "AGENT_TOKEN_IMPORT_REVOKED",
            message: "this token was revoked on this device and cannot be used here again -- issue a new one",
          });
        }
        return toSummary(existing);
      }
      const label = parsed.label && parsed.label.length > 0 ? parsed.label : null;
      const id = randomUUID();
      await deps.store.replace({ id, tokenHash, label });
      return { tokenId: id, label, createdAt: new Date().toISOString() };
    },

    /** Operator-only. Revokes the active token; idempotent. Never touches any channel token. */
    async revokeToken(): Promise<{ revoked: number }> {
      return { revoked: await deps.store.revoke() };
    },

    /** Operator-only status -- metadata only, never the token or its hash. `null` when none is active. */
    async getActiveToken(): Promise<FactoryTokenSummary | null> {
      const rows = await deps.store.listActive();
      return rows.length > 0 ? toSummary(rows[0]) : null;
    },

    /**
     * Verifies a presented token. Returns the binding, or throws `AGENT_TOKEN_INVALID` for a
     * missing, malformed, wrong-prefix (including a channel token), unknown, or revoked token --
     * deliberately one indistinguishable error.
     */
    async verifyToken(token: string | null | undefined): Promise<FactoryTokenBinding> {
      const invalid = () => new DomainError({ code: "AGENT_TOKEN_INVALID", message: "agent token is missing, unknown, or revoked" });
      if (typeof token !== "string" || !token.startsWith(FACTORY_AGENT_TOKEN_PREFIX) || token.length > 200) {
        throw invalid();
      }
      const row = await deps.store.findActiveByHash(hashFactoryToken(token));
      if (!row) throw invalid();
      return { tokenId: row.id };
    },
  };
}

export type FactoryTokenServices = ReturnType<typeof createFactoryTokenServices>;
