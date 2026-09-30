import { appDataPaths } from "@/lib/db";
import { createPathValidationFsAdapter } from "./adapters/fs";
import { validateWorkspacePath, type WorkspacePathValidationResult } from "./services";

/** Validates an operator-supplied local directory path against the real filesystem and this
 * process's real app-data directory. Operator-facing set paths only -- never an agent surface. */
export async function validateOperatorDirectoryPath(candidatePath: string): Promise<WorkspacePathValidationResult> {
  return validateWorkspacePath(candidatePath, {
    appDataDir: appDataPaths.appDataDir,
    ...createPathValidationFsAdapter(),
  });
}

export {
  isPathInsideOrEqual,
  overlapsAppDataDir,
  validateWorkspacePath,
  type PathValidationDependencies,
  type WorkspacePathValidationResult,
} from "./services";
