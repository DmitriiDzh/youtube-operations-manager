/**
 * Phase 12 (`docs/roadmap/plans/PHASE_12_PLAN.md` §6, slice 12.2) -- the process-wide, immutable
 * channel-bound agent scope.
 *
 * An MCP stdio server or a CLI invocation started with a valid agent token enters this scope ONCE,
 * at its entrypoint, before doing anything else. From then on the whole process is bound to that
 * token's channel and recorded Google identity:
 * - `db.ts`'s `getSelectedChannelId` returns the bound channel (for the bound user; `null`,
 *   fail-closed, for anyone else) and `setSelectedChannelId` is a silent no-op;
 * - `cli-auth`'s `resolveEffectiveCredentialRef` returns the bound identity and rejects any
 *   caller-supplied credential.
 * Every existing `assertActiveChannel`/`write-context` check therefore enforces the bound channel
 * unchanged -- enforcement at two choke points, not in each of dozens of handlers.
 *
 * Deliberately a zero-import leaf module (like `src/lib/batches/ledger-state.ts`), so `db.ts` can
 * depend on it without a cycle. The Next.js web process never calls `enterAgentSession`.
 */

export type AgentSessionScope = {
  readonly tokenId: string;
  readonly channelId: string;
  readonly userId: string;
};

let scope: AgentSessionScope | null = null;

/** Enters the scope. Throws if the process is already in one -- a scope can never be replaced. */
export function enterAgentSession(next: AgentSessionScope): void {
  if (scope) {
    throw new Error("agent session scope is already set for this process and cannot be changed");
  }
  scope = Object.freeze({ tokenId: next.tokenId, channelId: next.channelId, userId: next.userId });
}

export function getAgentSession(): AgentSessionScope | null {
  return scope;
}

/**
 * Tests only: run `fn` inside a scope, restoring the previous state afterwards (node:test runs each
 * test FILE in its own process, but tests within a file share this module).
 */
export async function withAgentSessionForTests<T>(next: AgentSessionScope | null, fn: () => Promise<T>): Promise<T> {
  const previous = scope;
  scope = next ? Object.freeze({ ...next }) : null;
  try {
    return await fn();
  } finally {
    scope = previous;
  }
}
