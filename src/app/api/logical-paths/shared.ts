import { NextResponse } from "next/server";
import { DomainError } from "@/lib/logical-paths/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

export type LogicalPathsSession = { user?: { id?: string | null } } | null;

export function logicalPathsErrorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json(
      { error: error.code, message: error.message, details: error.details },
      { status: getVideoMetadataErrorStatus(error.code) }
    );
  }
  return NextResponse.json(
    { error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" },
    { status: 500 }
  );
}

export async function readJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 }),
    };
  }
}
