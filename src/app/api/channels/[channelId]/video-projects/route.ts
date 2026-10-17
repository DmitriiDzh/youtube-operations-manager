import { createVideoProjectsRouteHandlers } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-194 stage 1 (ADR 0040): the active channel's videos by number, and «Новый ролик».
const handlers = createVideoProjectsRouteHandlers();
export const GET = handlers.list;
export const POST = handlers.create;
