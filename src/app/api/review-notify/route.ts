import { createReviewNotifyHandlers, defaultReviewNotifyRouteDeps } from "./shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-248 (ADR 0066): Settings → AI agent → «Будить Продюсера» (this computer only).
const handlers = createReviewNotifyHandlers(defaultReviewNotifyRouteDeps());
export const GET = handlers.GET;
export const PUT = handlers.PUT;
