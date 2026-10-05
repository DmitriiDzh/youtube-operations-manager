import { NextResponse } from "next/server";
import { defaultMediaRouteDeps, mediaHandler, type MediaRouteDeps } from "../shared";

/** Two RunPod reads (GPU types with price/availability, datacenters) for the Settings selects -- on an explicit "Load" click. */
export function createCatalogGetHandler(deps: MediaRouteDeps = defaultMediaRouteDeps()) {
  return mediaHandler(deps, async ({ core }) => {
    const [gpus, dataCenters] = await Promise.all([core.listGpuTypes(), core.listDataCenters()]);
    return NextResponse.json({ gpus, dataCenters });
  });
}

export const GET = createCatalogGetHandler();
