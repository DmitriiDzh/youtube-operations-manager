import { NextResponse } from "next/server";
import { OperationLockError } from "@/lib/operation-lock";
import { RecoveryModeError } from "@/lib/device-mutation-gate";

/**
 * BL-244 (ADR 0064, independent review): the upload queue routes (move, cancel/stop) pass the device mutation gate, whose
 * OperationLockError / RecoveryModeError do not extend DomainError on purpose (AGENTS.md §D). They are answered with their own
 * stable code -- 409 / 423, as the AI generate route does -- instead of a generic 500. Null for any other error.
 */
export function deviceGateErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof OperationLockError) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: 409 });
  if (error instanceof RecoveryModeError) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: 423 });
  return null;
}
