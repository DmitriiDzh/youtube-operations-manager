import { NextResponse } from "next/server";
import { DomainError } from "@/lib/market-intelligence/contracts";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

export type SessionLike = { user?: { id?: string | null } } | null;

export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export function errorResponse(error: unknown) {
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
