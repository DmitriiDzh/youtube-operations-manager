import { createPackageReviewAlertsHandler } from "../channels/[channelId]/package-reviews/handlers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Fix of BL-257 (ADR 0070): the packages waiting for the owner per connected channel -- the Media menu badge and the bell.
export const GET = createPackageReviewAlertsHandler();
