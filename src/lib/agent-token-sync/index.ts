import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createDefaultLogger } from "@/lib/shared-logger";
import {
  AGENT_TOKENS_REPORT_FORMAT,
  AGENT_TOKENS_REPORT_VERSION,
  createAgentTokensShareCoreForProduction,
  createAgentTokensSyncRunnerForProduction,
} from "@/lib/sync-gateway";
import { createAgentTokenSyncStore } from "./adapters/store";
import { createAgentTokenSyncServices, type AgentTokenSyncServices } from "./services";

// One instance per process (keyed on globalThis: the scheduler and the routes are compiled separately, and the "publish only when
// changed" memory must be shared by both).
const PRODUCTION_KEY = Symbol.for("ytom.agentTokenSync.core");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: AgentTokenSyncServices };

/** BL-160 -- see `./contracts.ts`. */
export function createAgentTokenSyncCoreForProduction(): AgentTokenSyncServices {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const share = createAgentTokensShareCoreForProduction();
    const bootstrap = createBootstrapConfigStore(getProductionAppPaths().bootstrapConfigPath);
    holder[PRODUCTION_KEY] = createAgentTokenSyncServices({
      store: createAgentTokenSyncStore(),
      share: {
        async listPeerTokens() {
          return (await share.listPeerReports()).flatMap((report) => report.tokens);
        },
        async publish(tokens) {
          await share.publishLocalReport({
            format: AGENT_TOKENS_REPORT_FORMAT,
            version: AGENT_TOKENS_REPORT_VERSION,
            deviceId: (await bootstrap.ensureExists()).deviceId,
            updatedAt: new Date().toISOString(),
            tokens,
          });
        },
      },
      pushNow: () => createAgentTokensSyncRunnerForProduction().runSyncCycle(),
      logger: createDefaultLogger(),
    });
  }
  return holder[PRODUCTION_KEY];
}

/**
 * Called after a token is issued, imported or revoked on this device: publishes the change at once instead of on the next minute.
 * It only publishes (reads this device's tables, writes the report file): applying the other devices' tokens is a database change
 * that waits for the scheduled step, which respects the recovery and operation-lock gate -- so a revoke made in recovery mode still
 * reaches the other devices. Best effort: never awaited by the caller and never failing it.
 */
export function shareAgentTokenChangeSoon(): void {
  try {
    void createAgentTokenSyncCoreForProduction()
      .tick({ applyPeers: false })
      .catch(() => undefined);
  } catch {
    // The sync module could not start (paths, config): the scheduled step will try again.
  }
}

export { reconcileAgentTokens, createAgentTokenSyncServices } from "./services";
export type { AgentTokenSyncServices, AgentTokenSyncDeps, SharedTokenView } from "./services";
export type { AgentTokenRecord, AgentTokenRole, AgentTokenSyncPlan } from "./contracts";
