import { stat } from "node:fs/promises";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { appDataPaths } from "@/lib/db";
import { validateOperatorDirectoryPath } from "@/lib/local-path-validation";
import { createLogicalPathStore } from "./adapters/store";
import { createLogicalPathServices } from "./services";

/**
 * Factory Operator access -- see `./contracts.ts`. Both deviceId accessors use the same bootstrap
 * config as `channel-workspaces`: reads only `read()` it (never creating it); the operator write
 * `ensureExists()`es it.
 */
export function createLogicalPathsCore() {
  const bootstrapConfigStore = createBootstrapConfigStore(appDataPaths.bootstrapConfigPath);
  return createLogicalPathServices({
    readDeviceId: async () => (await bootstrapConfigStore.read())?.deviceId ?? null,
    ensureDeviceId: async () => (await bootstrapConfigStore.ensureExists()).deviceId,
    store: createLogicalPathStore(),
    validatePath: validateOperatorDirectoryPath,
    // Operator listing only: a metadata check of the stored path itself, never a directory listing.
    pathExists: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
  });
}

export type LogicalPathsCore = ReturnType<typeof createLogicalPathsCore>;
export type {
  LogicalPathAudience,
  LogicalPathOperatorEntry,
  LogicalPathReadEntry,
  LogicalPathReadScope,
} from "./contracts";
export {
  createLogicalPathInputSchema,
  getLogicalPathInputSchema,
  setLogicalPathValueInputSchema,
} from "./schemas";
export { isDomainError } from "./contracts";
