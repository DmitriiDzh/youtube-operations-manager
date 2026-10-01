import { NextResponse } from "next/server";
import { ensureDatabaseInitialized, ungatedRecoveryClient } from "@/lib/db";
import {
  clearOperationLockIfUnchanged,
  describeOperationLock,
  getOperationLock,
  OPERATION_LOCK_FORCE_CONFIRMATION,
  type OperationType,
} from "@/lib/operation-lock";

// Stuck-lock recovery route. Deliberately independent of both the database initialization and the
// NextAuth session: it exists for exactly the case where initialization failed because of a stale
// lock, so neither could be relied on. In exchange it (a) only ever touches the operation-lock
// row, (b) requires a same-origin browser request (a page on another origin cannot trigger it), and
// (c) refuses a lock whose holder process is still alive unless the operator typed the explicit
// force confirmation. See docs/ARCHITECTURE.md ("Stuck operation lock recovery").

const OPERATION_TYPES = new Set<string>(["export", "import", "migration"]);
const DATABASE_STATUS_WAIT_MS = 1_500;

async function databaseStatus(): Promise<"ready" | "failed" | "starting"> {
  const settled = ensureDatabaseInitialized().then(
    () => "ready" as const,
    () => "failed" as const
  );
  const timeout = new Promise<"starting">((resolve) => setTimeout(() => resolve("starting"), DATABASE_STATUS_WAIT_MS));
  return Promise.race([settled, timeout]);
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    const lock = await getOperationLock(ungatedRecoveryClient);
    return NextResponse.json({
      status: lock ? describeOperationLock(lock) : null,
      database: await databaseStatus(),
    });
  } catch {
    return NextResponse.json({ error: "operation_lock_unreadable" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { operationType, holderPid, acquiredAt, force, confirmation } = body;
  if (
    typeof operationType !== "string" ||
    !OPERATION_TYPES.has(operationType) ||
    typeof holderPid !== "number" ||
    !Number.isInteger(holderPid) ||
    typeof acquiredAt !== "string"
  ) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (force === true && confirmation !== OPERATION_LOCK_FORCE_CONFIRMATION) {
    return NextResponse.json({ error: "force_confirmation_required" }, { status: 400 });
  }

  try {
    const result = await clearOperationLockIfUnchanged(
      ungatedRecoveryClient,
      { operationType: operationType as OperationType, holderPid, acquiredAt },
      { force: force === true }
    );
    const status = result.outcome === "cleared" || result.outcome === "not_held" ? 200 : 409;
    return NextResponse.json({ ...result, database: await databaseStatus() }, { status });
  } catch {
    return NextResponse.json({ error: "operation_lock_clear_failed" }, { status: 500 });
  }
}
