import { createStoryboardRouteHandlers } from "../../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-184: «Одобрить эту версию» / «Запросить изменения» -- on the latest version, once submitted.
export const POST = createStoryboardRouteHandlers().decide;
