import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { createPerDeviceReportCore } from "../per-device-report";
import { createFsPerDeviceReportStore } from "../per-device-report/fs-store";
import { GENERATION_PLANS_REPORT_VERSION, generationPlansReportSchema, type GenerationPlansReport } from "./contracts";

// BL-143 phase 2: the generation plans report family -- the shared per-device report mechanics with this family's schema.

export function createGenerationPlansShareCore(deps: Omit<Parameters<typeof createPerDeviceReportCore<GenerationPlansReport>>[0], "schema" | "label">) {
  return createPerDeviceReportCore<GenerationPlansReport>({ schema: generationPlansReportSchema, label: "generation plans report", currentVersion: GENERATION_PLANS_REPORT_VERSION, ...deps });
}
export type GenerationPlansShareCore = ReturnType<typeof createGenerationPlansShareCore>;

const PRODUCTION_KEY = Symbol.for("ytom.syncGateway.generationPlansShareCore");
type GlobalWithInstance = typeof globalThis & { [PRODUCTION_KEY]?: GenerationPlansShareCore };

export function createGenerationPlansShareCoreForProduction(): GenerationPlansShareCore {
  const holder = globalThis as GlobalWithInstance;
  if (!holder[PRODUCTION_KEY]) {
    const paths = getProductionAppPaths();
    const bootstrap = createBootstrapConfigStore(paths.bootstrapConfigPath);
    holder[PRODUCTION_KEY] = createGenerationPlansShareCore({
      store: createFsPerDeviceReportStore(paths.generationPlansShareDir),
      ownDeviceId: async () => (await bootstrap.ensureExists()).deviceId,
      clock: { now: () => new Date() },
    });
  }
  return holder[PRODUCTION_KEY];
}

export * from "./contracts";
