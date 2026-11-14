import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { isRemoteRequest } from "@/lib/loopback-guard";
import { getRemoteAccess, type RemoteAccessServices } from "@/lib/remote-access";
import { DomainError, isDomainError } from "@/lib/shared-domain";

// BL-251 (REMOTE_ACCESS_PLAN.md): Settings → «Доступ с других устройств». GET the status (never the hash); PUT
// `{ enabled?, password? }` only from the Mac itself (also refused by src/proxy.ts for remote requests; checked here again).

export type RemoteAccessRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: () => Pick<RemoteAccessServices, "status" | "setEnabled" | "setPassword">;
};

export function defaultRemoteAccessRouteDeps(): RemoteAccessRouteDeps {
  return { getSession: () => getServerSession(authOptions), core: getRemoteAccess };
}

export function createRemoteAccessHandlers(deps: RemoteAccessRouteDeps) {
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
    GET: (request: Request) => guarded(async () => NextResponse.json({ ...(await deps.core().status()), thisRequestRemote: isRemoteRequest(request.headers) })),

    PUT: (request: Request) =>
      guarded(async () => {
        if (isRemoteRequest(request.headers)) {
          throw new DomainError({ code: "remote_access_mac_only", message: "Access from other devices is set up only on the Mac itself." });
        }
        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return NextResponse.json({ error: "validation_failed", message: "Request body must be a JSON object" }, { status: 400 });
        }
        const core = deps.core();
        if (body.password !== undefined) await core.setPassword(body.password);
        if (body.enabled !== undefined) await core.setEnabled(body.enabled);
        return NextResponse.json(await core.status());
      }),
  };
}
