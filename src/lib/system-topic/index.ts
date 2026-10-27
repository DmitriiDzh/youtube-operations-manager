import { randomBytes, randomUUID } from "node:crypto";
import { rawSqlClient } from "@/lib/db";
import { createDefaultLogger } from "@/lib/shared-logger";
import { createSystemApprovals, type SystemApprovalAction, type SystemApprovals } from "./approvals";
import { createSystemRequestStore, systemRequestFiles } from "./adapters/requests";
import { createSystemTopicStore } from "./adapters/store";
import { createSystemTopic, type SystemTopic } from "./services";

// BL-228 (docs/roadmap/plans/SYSTEM_TOPIC_PLAN.md, ADR 0053 Amendment 1): the System topic module wired to this computer -- its
// tables, the factory's requests folder, the logger. The allowlisted paid actions are NOT wired here: they are another module's
// service code, composed in `src/composition/system-topic-approvals.ts` and handed in (AGENTS.md §M). Off by default; the rest of
// the app never depends on it.

/** How often the requests folder is scanned while the feature is on. */
export const SYSTEM_TOPIC_SCAN_TICK_MS = 10_000;

/** The Mac service: the only place the switch may be on. */
export function isSystemTopicServiceMode(): boolean {
  return process.env.YTOM_SERVICE_MODE === "1" && process.platform === "darwin";
}

export type SystemTopicCore = { topic: SystemTopic; approvals: SystemApprovals };

const CORE_KEY = Symbol.for("youtube-operations-manager.system-topic");

/** One instance per process (the routes and the server's scan loop are separate bundles). The first caller's actions win. */
export function createSystemTopicCore(actions: Readonly<Record<string, SystemApprovalAction>>): SystemTopicCore {
  const holder = globalThis as unknown as Record<symbol, SystemTopicCore | undefined>;
  const existing = holder[CORE_KEY];
  if (existing) return existing;
  const logger = createDefaultLogger();
  const log = (event: string, context: Record<string, unknown>) => logger.info({ event, context });
  const store = createSystemTopicStore(rawSqlClient);
  const clock = () => Date.now();
  const enqueue = (text: string) => store.enqueueOutbox({ id: randomUUID(), text, createdAt: clock() });
  const approvals = createSystemApprovals({
    store: createSystemRequestStore(rawSqlClient),
    files: systemRequestFiles,
    actions,
    readState: () => store.read(),
    serviceMode: isSystemTopicServiceMode,
    enqueue,
    clock,
    log,
  });
  const topic = createSystemTopic({
    store,
    serviceMode: isSystemTopicServiceMode,
    clock,
    newId: () => randomUUID(),
    randomBytes: () => randomBytes(32),
    approvals: approvals.commands,
    log,
  });
  const core = { topic, approvals };
  holder[CORE_KEY] = core;
  return core;
}

export * from "./contracts";
export { parseSystemCommand } from "./parser";
export type { SystemTopic } from "./services";
export type { SystemApprovalAction, SystemApprovals, SystemRequestView } from "./approvals";
export { SYSTEM_APPROVAL_ACTOR } from "./approvals";
