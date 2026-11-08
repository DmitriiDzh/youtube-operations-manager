import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { getReviewNotifyCore } from "@/composition/review-notify";
import { authOptions } from "@/lib/auth";
import type { ReviewNotify } from "@/lib/review-notify";
import { isDomainError } from "@/lib/shared-domain";

// BL-248 (ADR 0066): Settings → AI agent → «Будить Продюсера». Read the card (GET) and save this computer's switch and Inbox folder
// (PUT, which passes `src/proxy.ts`'s device mutation gate like every mutating /api route). Web UI only: no MCP tool reaches it.

export type ReviewNotifyRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: () => Pick<ReviewNotify, "view" | "updateSettings">;
};

export function defaultReviewNotifyRouteDeps(): ReviewNotifyRouteDeps {
  return { getSession: () => getServerSession(authOptions), core: getReviewNotifyCore };
}

export function createReviewNotifyHandlers(deps: ReviewNotifyRouteDeps) {
  async function guarded(run: () => Promise<NextResponse>): Promise<NextResponse> {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      return await run();
    } catch (error) {
      if (isDomainError(error)) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  }

  return {
    /** GET /api/review-notify: the card. */
    GET: () => guarded(async () => NextResponse.json(await deps.core().view())),

    /** PUT /api/review-notify `{ enabled?: boolean | null, inboxPath?: string | null }`. */
    PUT: (request: Request) =>
      guarded(async () => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return NextResponse.json({ error: "validation_failed", message: "Request body must be a JSON object" }, { status: 400 });
        }
        return NextResponse.json(await deps.core().updateSettings(body));
      }),
  };
}
