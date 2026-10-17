import { createVideoCostsRouteHandlers } from "../handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-194 stage 3 (ADR 0041): one video's total and every run behind it, on every computer.
export const GET = createVideoCostsRouteHandlers().video;
