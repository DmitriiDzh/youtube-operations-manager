import path from "node:path";
import { createKeyFile, createKeyFileFsAccess } from "@/lib/device-key-file";
import {
  appDataPaths,
  deleteStoredDeviceSecret,
  getStoredDeviceSecret,
  isDeviceSecretMigrated,
  markDeviceSecretMigrated,
  setStoredDeviceSecretStatus,
  upsertStoredDeviceSecret,
} from "@/lib/db";
import { DomainError } from "@/lib/shared-domain";
import { DEVICE_SECRETS_KEY_FILE_NAME, type DeviceSecretStorePort } from "./contracts";
import { legacyGeminiSource, legacyMediaSealKey, legacyRunpodSource } from "./legacy";
import { createDeviceSecrets, type DeviceSecrets } from "./services";

export * from "./contracts";
export { createDeviceSecrets, type DeviceSecrets, type DeviceSecretSlot, type DeviceSecretsDeps } from "./services";

const store: DeviceSecretStorePort = {
  get: (name) => getStoredDeviceSecret(name),
  upsert: (row) => upsertStoredDeviceSecret(row),
  setStatus: (name, expectedRevision, patch) => setStoredDeviceSecretStatus(name, expectedRevision, patch),
  delete: (name) => deleteStoredDeviceSecret(name),
  isMigrated: (name) => isDeviceSecretMigrated(name),
  markMigrated: (name, at) => markDeviceSecretMigrated(name, at),
};

/** The file path of this computer's key file (in the app-data folder, never in a synced folder). */
export function deviceSecretsKeyFilePath(appDataDir: string = appDataPaths.appDataDir): string {
  return path.join(appDataDir, DEVICE_SECRETS_KEY_FILE_NAME);
}

/**
 * One instance per process, on `globalThis` (route bundles must share the in-process migration guard, the BL-116 lesson). Every
 * feature module asks this for its slot.
 */
export function getDeviceSecrets(): DeviceSecrets {
  const key = Symbol.for("youtube-operations-manager.device-secrets");
  const g = globalThis as unknown as Record<symbol, DeviceSecrets | undefined>;
  return (g[key] ??= createDeviceSecrets({
    store,
    keyFile: createKeyFile(
      createKeyFileFsAccess(deviceSecretsKeyFilePath()),
      (detail) =>
        new DomainError({
          code: "encryption_key_not_configured",
          message: `This computer's secrets key file exists but is unusable (${detail}). Clear the stored keys and enter them again.`,
        })
    ),
    legacy: { runpod: legacyRunpodSource(appDataPaths.appDataDir), gemini: legacyGeminiSource(appDataPaths.appDataDir) },
    legacySealKey: legacyMediaSealKey(appDataPaths.appDataDir),
  }));
}
