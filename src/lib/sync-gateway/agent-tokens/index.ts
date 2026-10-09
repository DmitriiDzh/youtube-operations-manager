import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createFsAgentTokensReportStore } from "./adapters/fs-store";
import { createAgentTokensShareCore, type AgentTokensShareCore } from "./services";

// One instance per process (keyed on globalThis, like the other families: the scheduler and the routes are compiled separately).
const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.agentTokensShareCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: AgentTokensShareCore };

export function createAgentTokensShareCoreForProduction(): AgentTokensShareCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const bootstrap = createBootstrapConfigStore(paths.bootstrapConfigPath);
    holder[PRODUCTION_KEY] = createAgentTokensShareCore({
      store: createFsAgentTokensReportStore(paths.agentTokensShareDir),
      ownDeviceId: async () => (await bootstrap.ensureExists()).deviceId,
      clock: { now: () => new Date() },
    });
  }
  return holder[PRODUCTION_KEY];
}

export { createAgentTokensShareCore } from "./services";
export type { AgentTokensShareCore, AgentTokensReportStore } from "./services";
export * from "./contracts";
