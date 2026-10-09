import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/shared-domain";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError };

/**
 * The token of an agent ROLE (the Factory Operator, ADR 0022; the Producer, BL-161): bound to no channel and no Google
 * identity, one active token at a time, only its SHA-256 hash stored. Extracted from `factory-agent-tokens` when the Producer
 * became the second such role (AGENTS.md §M: one implementation shared by both role modules, owned by neither). Each role
 * module supplies its own prefix, name and table; a channel token (`src/lib/agent-tokens`) is a different thing.
 */

/** What a verified token grants: the role itself (there is nothing else to bind to). */
export type RoleTokenBinding = { tokenId: string };

/** Operator-facing metadata -- never the token or its hash. */
export type RoleTokenSummary = { tokenId: string; label: string | null; createdAt: string };

export type IssuedRoleToken = RoleTokenSummary & {
  /** Plaintext, returned exactly once at issue time and never retrievable again. */
  token: string;
};

/** How a role is named in its own messages, e.g. `{ prefix: "ytom_fo_", name: "Factory Operator" }`. */
export type RoleTokenKind = { prefix: string; name: string };
