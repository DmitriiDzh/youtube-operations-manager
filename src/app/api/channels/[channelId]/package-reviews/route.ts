import { createPackageReviewRouteHandlers } from "./handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// BL-257 (ADR 0070): the active channel's final packages for the owner's review, and his switch (Медиа → «Видео на проверку»).
export const GET = createPackageReviewRouteHandlers().list;
export const PUT = createPackageReviewRouteHandlers().setRequired;
