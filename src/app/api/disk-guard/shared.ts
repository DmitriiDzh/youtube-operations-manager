import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { getDiskGuardCore } from "@/composition/disk-guard";
import { authOptions } from "@/lib/auth";
import type { DiskGuard } from "@/lib/disk-guard";
import { isDomainError } from "@/lib/shared-domain";

// BL-237: the disk guard's routes -- the «Диск» card on Servers and the header bell. Local reads only, except the threshold
// (PUT, which passes `src/proxy.ts`'s device mutation gate like every mutating /api route).

export type DiskGuardRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: () => Pick<DiskGuard, "view" | "notice" | "updateSettings">;
};

export function defaultDiskGuardRouteDeps(): DiskGuardRouteDeps {
  return { getSession: () => getServerSession(authOptions), core: getDiskGuardCore };
}

export function createDiskGuardHandlers(deps: DiskGuardRouteDeps) {
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
    /** GET /api/disk-guard[?measure=1]: the card. `measure=1` also measures the big folders (a few seconds at most). */
    GET: (request: Request) => guarded(async () => NextResponse.json(await deps.core().view({ measure: new URL(request.url).searchParams.get("measure") === "1" }))),

    /** GET /api/disk-guard/notice: the bell. A failure is "no notice" -- the bell never breaks over this. */
    GET_NOTICE: () =>
      guarded(async () => {
        try {
          return NextResponse.json({ notice: await deps.core().notice() });
        } catch {
          return NextResponse.json({ notice: null });
        }
      }),

    /** PUT /api/disk-guard/settings `{ thresholdGb }`. */
    PUT_SETTINGS: (request: Request) =>
      guarded(async () => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return NextResponse.json({ error: "validation_failed", message: "Request body must be a JSON object" }, { status: 400 });
        }
        return NextResponse.json({ settings: await deps.core().updateSettings(body) });
      }),
  };
}
