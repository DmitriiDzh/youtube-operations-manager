import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { rawSqlClient } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-handoff";
import { OperationLockError } from "@/lib/operation-lock";
import { RecoveryModeError } from "@/lib/device-handoff";

// Next.js 16 renamed `middleware.ts` to `proxy.ts` (functionally identical) --
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md. Proxy
// defaults to the Node.js runtime in this version (not Edge), which is what makes it possible
// to query the local libSQL database directly here, the same way any API route already does.

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// The device-handoff export/import routes manage src/lib/operation-lock themselves (acquiring
// it is the whole point of calling them) -- gating them here too would make every handoff
// action deadlock against its own lock. NextAuth's callback route establishes this device's
// own OAuth session, which decision 6 (docs/decisions/0002-...) explicitly keeps independent
// of the handoff/recovery-mode gate. (Recovery mode's own real protection against a device
// re-importing over unresolved state lives inside `importHandoff` itself, not here -- see its
// doc comment; found by independent review that this exemption alone was not sufficient.)
const EXEMPT_PATH_PREFIXES = ["/api/device-handoff", "/api/auth"];

// These POST routes are read-only/preview with respect to both local persistence and YouTube --
// per their own doc comments, none of them create a Change/ChangeSet, write a batch ledger row,
// or call a YouTube write method; they only return a proposal for human review. Classified here
// to match `docs/DEVELOPMENT_PLAYBOOK.md` §6.7's read/local-mutation/remote-mutation split and
// kept consistent with the CLI's `READ_ONLY_CLI_COMMANDS` and MCP's un-wrapped read-only tools
// (`src/cli/video-metadata.ts`, `src/mcp/server.ts`) -- found by independent review that this
// file previously gated every POST regardless of what it actually did, diverging from both.
const EXEMPT_READ_ONLY_PATHS = new Set([
  "/api/video-metadata/preview",
  "/api/video-metadata/transcript",
]);
const EXEMPT_READ_ONLY_PATH_SUFFIXES = [
  "/localizations/import/preview",
  "/ai-localization/generate",
  "/details/preview",
];

function isExemptReadOnlyPath(pathname: string): boolean {
  if (EXEMPT_READ_ONLY_PATHS.has(pathname)) return true;
  return EXEMPT_READ_ONLY_PATH_SUFFIXES.some((suffix) => pathname.endsWith(suffix));
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!pathname.startsWith("/api/")) return NextResponse.next();
  if (!MUTATING_METHODS.has(request.method)) return NextResponse.next();
  if (EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }
  if (isExemptReadOnlyPath(pathname)) {
    return NextResponse.next();
  }

  try {
    await assertDeviceAvailableForMutation(rawSqlClient);
  } catch (error) {
    if (error instanceof OperationLockError) {
      return NextResponse.json(
        { error: error.code, message: error.message, details: error.details },
        { status: 409 }
      );
    }
    if (error instanceof RecoveryModeError) {
      return NextResponse.json(
        { error: error.code, message: error.message, details: error.details },
        { status: 423 }
      );
    }
    const message = error instanceof Error ? error.message : "Device unavailable for mutation.";
    return NextResponse.json({ error: "device_unavailable", message }, { status: 503 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
