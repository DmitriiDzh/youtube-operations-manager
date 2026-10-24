import { createPreviewHandler } from "./handlers";
import { previewDeps } from "./deps";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-219: a preview of one image output of this computer's job, for Servers → «Аналитика» (AC-SA-09).
export const GET = createPreviewHandler(previewDeps);
