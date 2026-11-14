import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "@/lib/atomic-json-file";
import { appDataPaths } from "@/lib/db";
import { createRemoteAccessServices, type RemoteAccessServices } from "./services";

// BL-251: the module's public surface. The state lives in `<app data>/remote-access.json` on THIS Mac (a device handoff copies
// the database, never this file), written atomically with owner-only permissions.
export * from "./contracts";
export { hasProxyHeaders, isRemoteRequest, isSameOriginMutation, ownOrigin } from "./classify";
export { createRemoteAccessServices, stateFromJson, type RemoteAccessServices, type RemoteAccessStore } from "./services";

const KEY = Symbol.for("youtube-operations-manager.remote-access");

export function remoteAccessFilePath(): string {
  return path.join(appDataPaths.appDataDir, "remote-access.json");
}

export function getRemoteAccess(): RemoteAccessServices {
  const holder = globalThis as unknown as Record<symbol, RemoteAccessServices | undefined>;
  return (holder[KEY] ??= createRemoteAccessServices({
    store: {
      read: () => readFile(remoteAccessFilePath(), "utf8").catch(() => null),
      async write(json) {
        await writeFileAtomic(remoteAccessFilePath(), json);
        await import("node:fs/promises").then((fs) => fs.chmod(remoteAccessFilePath(), 0o600)).catch(() => undefined);
      },
    },
    clock: { now: () => Date.now() },
  }));
}
