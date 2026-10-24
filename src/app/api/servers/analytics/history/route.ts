import { createSpendAnalyticsHandlers } from "../handlers";
import { productionDeps } from "../deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-219: Servers → «Аналитика», the unified history, 30 rows a page (AC-SA-07).
export const GET = createSpendAnalyticsHandlers(productionDeps).history;
