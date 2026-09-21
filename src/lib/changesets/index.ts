import { createDefaultLogger } from "@/lib/channel-sync/adapters/logger";
import { createChangeSetChannelStoreAdapter, createIdGenerator } from "./adapters/store";
import { createAutomergeBackedChangeSetStoreAdapter } from "./adapters/change-drafts-store";
import { createChangeSetServices } from "./services";

// Cutover, 2026-09-21 (AUTOMERGE_MIGRATION_PLAN.md §6 CD2, docs/decisions/0006-*.md): writes now
// go through src/lib/change-drafts/ (Automerge) instead of directly to SQL -- this is the single
// place that changes. `createChangeSetServices` itself, and every one of its callers (API routes,
// MCP tools, CLI commands), is completely unaffected; they only ever depended on the adapter's
// interface, never on how it's implemented underneath.
export function createChangeSetCore() {
  return createChangeSetServices({
    channelStore: createChangeSetChannelStoreAdapter(),
    changeSetStore: createAutomergeBackedChangeSetStoreAdapter(),
    idGenerator: createIdGenerator(),
    logger: createDefaultLogger(),
  });
}

export type ChangeSetCore = ReturnType<typeof createChangeSetCore>;
