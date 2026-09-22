import { clearStoredCloudConnection, getStoredCloudConnection, upsertStoredCloudConnection } from "@/lib/db";

export function createCloudConnectionStoreAdapter() {
  return {
    get: getStoredCloudConnection,
    upsert: upsertStoredCloudConnection,
    clear: clearStoredCloudConnection,
  };
}
