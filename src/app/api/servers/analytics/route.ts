import { createSpendAnalyticsHandlers } from "./handlers";
import { productionDeps } from "./deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-219: Servers → «Аналитика», the summary (AC-SA-01..06).
export const GET = createSpendAnalyticsHandlers(productionDeps).summary;
