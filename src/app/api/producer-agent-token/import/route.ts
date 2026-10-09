import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createProducerTokenCore } from "@/lib/producer-agent-tokens";
import { DomainError } from "@/lib/producer-agent-tokens/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

type ImportProducerTokenRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<ReturnType<typeof createProducerTokenCore>, "importToken">;
};

const defaultDeps: ImportProducerTokenRouteDeps = {
  getSession: () => getServerSession(authOptions),
  core: createProducerTokenCore(),
};

// BL-161 (as BL-130's factory import, docs/roadmap/plans/AGENT_TOKEN_IMPORT_PLAN.md §2.4) -- operator-only: registers on
// this device the Producer token already issued on another one. The request carries the plaintext; the
// response never does (metadata only), and no error body echoes it. A mutating route behind the normal
// `src/proxy.ts` device-availability gate -- unlike revoke, it is not a stop switch.
export function createImportProducerTokenPostHandler(deps: ImportProducerTokenRouteDeps = defaultDeps) {
  return async function POST(request: Request) {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }
    try {
      const imported = await deps.core.importToken(body);
      return NextResponse.json({ token: imported }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json(
          { error: error.code, message: error.message, details: error.details },
          { status: getVideoMetadataErrorStatus(error.code) }
        );
      }
      // Never `error.message` here: an unexpected failure's text is not guaranteed free of the input.
      return NextResponse.json({ error: "internal_error", message: "Token import failed" }, { status: 500 });
    }
  };
}

export const POST = createImportProducerTokenPostHandler();
