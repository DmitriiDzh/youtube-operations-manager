import os from "node:os";
import path from "node:path";
import { getDiskGuardSettingsJson, getDiskGuardStateJson, setDiskGuardSettingsJson, setDiskGuardStateJson } from "@/lib/db";
import { getProductionAppPaths } from "@/lib/platform-paths";
import { createDefaultLogger } from "@/lib/shared-logger";
import { folderSize, readVolumes } from "./adapters/fs";
import { DISK_GUARD_WALK_BUDGET_MS, type DiskConsumer, type DiskConsumerKey } from "./contracts";
import { createDiskGuard, type DiskGuard } from "./services";

// BL-237: the disk guard wired to this computer -- its app-data folder, the program folder (the server's working folder),
// this computer's settings rows. The System topic is not wired here (AGENTS.md §M): the caller hands in how to post.

/** The app's big folders whose sizes an alert and the card show. */
export function diskConsumerPlaces(): Array<{ key: DiskConsumerKey; path: string }> {
  const paths = getProductionAppPaths();
  return [
    { key: "liveStreamsBuffer", path: paths.liveStreamsBufferDir },
    { key: "backups", path: paths.backupsDir },
    { key: "nextCache", path: path.join(process.cwd(), ".next", "cache") },
    { key: "tempDir", path: os.tmpdir() },
  ];
}

export function createDiskGuardCore(input: { postSystemMessage(text: string): Promise<boolean> }): DiskGuard {
  const logger = createDefaultLogger();
  return createDiskGuard({
    volumes: () =>
      readVolumes([
        { label: "appData", path: getProductionAppPaths().appDataDir },
        { label: "program", path: process.cwd() },
      ]),
    measureConsumers: async () => {
      const out: DiskConsumer[] = [];
      // One after another: each walk is bounded, and they never compete with each other for the disk.
      for (const place of diskConsumerPlaces()) out.push({ ...place, ...(await folderSize(place.path, { budgetMs: DISK_GUARD_WALK_BUDGET_MS })) });
      return out;
    },
    getSettingsJson: () => getDiskGuardSettingsJson(),
    setSettingsJson: (json) => setDiskGuardSettingsJson(json),
    getStateJson: () => getDiskGuardStateJson(),
    setStateJson: (json) => setDiskGuardStateJson(json),
    postSystemMessage: input.postSystemMessage,
    hostname: () => os.hostname(),
    clock: () => Date.now(),
    log: (event, context) => logger.info({ event, context }),
  });
}

export * from "./contracts";
export { decideDiskAlert, diskAlertMessage } from "./services";
export type { DiskGuard } from "./services";
