import { appDataPaths, getOperationsWorkspacePath } from "@/lib/db";
import { createFsAdapter } from "./adapters/fs";
import { createOperationsInstructionsServices, validateWorkspacePath, type WorkspacePathValidationResult } from "./services";
import { isDomainError } from "./contracts";

/**
 * Used only by `POST /api/settings` (the sole place this path can ever be set) -- never by any
 * agent-callable MCP tool or CLI command.
 */
export async function validateOperationsWorkspacePath(candidatePath: string): Promise<WorkspacePathValidationResult> {
  const fsAdapter = createFsAdapter();
  return validateWorkspacePath(candidatePath, {
    appDataDir: appDataPaths.appDataDir,
    realpath: fsAdapter.realpath,
    stat: fsAdapter.stat,
  });
}

export function createOperationsInstructionsCore() {
  const fsAdapter = createFsAdapter();
  return createOperationsInstructionsServices({
    getConfiguredPath: getOperationsWorkspacePath,
    appDataDir: appDataPaths.appDataDir,
    realpath: fsAdapter.realpath,
    readdir: fsAdapter.readdir,
    lstat: fsAdapter.lstat,
    stat: fsAdapter.stat,
    readFileHead: fsAdapter.readFileHead,
  });
}

export type OperationsInstructionsCore = ReturnType<typeof createOperationsInstructionsCore>;
export type { OperationsWorkspaceFileEntry, OperationsWorkspaceFileResult, OperationsWorkspaceListResult } from "./contracts";
export { isDomainError };
