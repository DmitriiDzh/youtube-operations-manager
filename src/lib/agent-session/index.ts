/**
 * Channel-bound agent scope (`docs/roadmap/plans/PHASE_12_PLAN.md` §6, re-based on a per-request
 * scope by `docs/decisions/0013-in-app-http-mcp-transport.md`).
 *
 * The in-app MCP endpoint (`src/lib/agent-mcp-endpoint`) validates a channel token on EVERY request
 * and runs that request inside this scope. While inside it:
 * - `db.ts`'s `getSelectedChannelId` returns the bound channel (for the bound user; `null`,
 *   fail-closed, for anyone else) and `setSelectedChannelId` is a silent no-op;
 * - `cli-auth`'s `resolveEffectiveCredentialRef` returns the bound identity and rejects any
 *   caller-supplied credential.
 * Every existing `assertActiveChannel`/`write-context` check therefore enforces the bound channel
 * unchanged -- enforcement at two choke points, not in each of dozens of handlers.
 *
 * The scope is carried by an `AsyncLocalStorage`, never by a process-wide variable: the web process
 * serves the operator's own requests concurrently with agent requests, and "no scope" there means
 * OPERATOR mode. There is deliberately no way to enter a scope other than `runInAgentSession`, and
 * no ambient/process-wide scope at all. The instance is stored on `globalThis` under a
 * `Symbol.for` key so that bundling or hot reloading can never create a second instance (a second
 * instance would silently see no scope).
 *
 * Deliberately a leaf module (only `node:async_hooks`), so `db.ts` can depend on it without a cycle.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type AgentSessionScope = {
  readonly tokenId: string;
  readonly channelId: string;
  readonly userId: string;
};

const STORE_KEY = Symbol.for("ytom.agent-session.async-local-storage");

function store(): AsyncLocalStorage<AgentSessionScope> {
  const holder = globalThis as typeof globalThis & { [STORE_KEY]?: AsyncLocalStorage<AgentSessionScope> };
  return (holder[STORE_KEY] ??= new AsyncLocalStorage<AgentSessionScope>());
}

function freeze(next: AgentSessionScope): AgentSessionScope {
  return Object.freeze({ tokenId: next.tokenId, channelId: next.channelId, userId: next.userId });
}

/** Runs `fn` (and everything it awaits) inside the given scope. The scope ends when `fn` settles. */
export function runInAgentSession<T>(next: AgentSessionScope, fn: () => Promise<T>): Promise<T> {
  return store().run(freeze(next), fn);
}

/** The scope of the request currently being served, or `null` (operator / non-agent code). */
export function getAgentSession(): AgentSessionScope | null {
  return store().getStore() ?? null;
}

/**
 * Fail-closed check for the instant before an agent tool handler runs: the ambient scope must be
 * exactly the one this request authenticated as. A lost async context would otherwise degrade into
 * operator mode (credentialRef honoured, selection writes real, no channel clamp).
 */
export function assertAgentSession(expectedTokenId: string): AgentSessionScope {
  const current = getAgentSession();
  if (!current || current.tokenId !== expectedTokenId) {
    throw new Error("agent session scope is missing or does not match this request");
  }
  return current;
}

/**
 * Tests only: run `fn` inside a scope, or with no scope at all when `next` is null (even if the
 * caller is itself inside one).
 */
export async function withAgentSessionForTests<T>(next: AgentSessionScope | null, fn: () => Promise<T>): Promise<T> {
  return next ? runInAgentSession(next, fn) : store().exit(fn);
}
