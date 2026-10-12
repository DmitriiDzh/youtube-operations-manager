import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths";

// BL-176: this computer's device id (the bootstrap config's), the id its live-streams report is published under.
export async function getBootstrapDeviceId(): Promise<string> {
  return (await createBootstrapConfigStore(getProductionAppPaths().bootstrapConfigPath).ensureExists()).deviceId;
}
