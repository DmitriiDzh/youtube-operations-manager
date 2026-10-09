import { z } from "zod";
import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-160 (owner, Telegram 2026-10-09, msg 2200 -- "можно сделать чтобы токены всех агентов работали одинаково"; plan
// docs/roadmap/plans/PRODUCER_ROLE_PLAN.md §2): every device publishes the agent tokens it knows -- their SHA-256 hashes, never the
// tokens -- so a token issued on one device is accepted on the others and a revocation reaches them all. A per-device report like
// media-sessions: each device writes only its OWN report and keeps the latest report of every peer; nothing is merged here. The
// rules that turn the reports into accepted tokens belong to `src/lib/agent-token-sync` (this family imports nothing from it).

/** The one constant key this family is synced under (one report per device). */
export const GLOBAL_DOCUMENT_KEY = "global";
export const AGENT_TOKENS_REPORT_FORMAT = "ytm-agent-tokens";
export const AGENT_TOKENS_REPORT_VERSION = 1;

/** A token as another device may see it: what it is for and whether it is revoked. */
export const sharedAgentTokenSchema = z
  .object({
    /** SHA-256 hex of the whole token -- the only thing a device stores of a token. */
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    role: z.enum(["channel", "factory", "producer"]),
    /** The channel a channel token is bound to; null for a role token. */
    channelId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
    /** The Google account (`users.id`, Google's stable `sub`) a channel token was issued under; null for a role token. */
    userId: z.string().min(1).max(255).nullable(),
    label: z.string().max(100).nullable(),
    createdAt: z.string().datetime({ offset: true }),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .refine((token) => (token.role === "channel" ? token.channelId !== null && token.userId !== null : token.channelId === null && token.userId === null), {
    message: "a channel token names its channel and Google account; a role token names neither",
  });

export const agentTokensReportSchema = z
  .object({
    format: z.literal(AGENT_TOKENS_REPORT_FORMAT),
    version: z.literal(AGENT_TOKENS_REPORT_VERSION),
    deviceId: z.string().min(1).max(128),
    updatedAt: z.string().datetime({ offset: true }),
    // Revoked tokens stay listed for good (a revocation must never be forgotten); a generous bound, not a working limit.
    tokens: z.array(sharedAgentTokenSchema).max(50_000),
  })
  .strict();

export type SharedAgentToken = z.infer<typeof sharedAgentTokenSchema>;
export type AgentTokensReport = z.infer<typeof agentTokensReportSchema>;
