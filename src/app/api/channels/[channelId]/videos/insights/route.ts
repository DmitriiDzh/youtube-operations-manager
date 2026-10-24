import { createVideoInsightsHandler } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-221: each synced video's kind and its last 7 days of views and reach (local data).
export const GET = createVideoInsightsHandler();
