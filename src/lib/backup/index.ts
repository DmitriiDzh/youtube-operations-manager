import { createFilesystemBackupStore } from "./adapters/filesystem-store";
import { createBackupServices } from "./services";

export function createBackupCore() {
  return createBackupServices({
    store: createFilesystemBackupStore(),
    clock: () => new Date(),
  });
}

export type BackupCore = ReturnType<typeof createBackupCore>;
