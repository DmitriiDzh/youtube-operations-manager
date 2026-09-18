import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createBatchCore } from "@/lib/batches";
import { DomainError } from "@/lib/batches/contracts";
import { createBatchInputSchema, parseWithSchema } from "@/lib/batches/schemas";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createBatchCore();

// Phase 5 Web UI/API (DEC-OQ-5: Web UI/API only, no CLI/MCP write tools). This route
// covers only "select approved changes -> create a Batch -> inspect it" (AGENTS.md §G's
// dry-run-by-default requirement, AC-DRYRUN-02). There is deliberately no route or
// service call anywhere in this API surface that reaches the live-execution service
// function (the one that accepts a real write-execution adapter) -- see
// src/lib/batches/write-path-inventory.test.ts, which fails the build if that changes.

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId } = await params;
    const batches = await core.listBatchesByChannel(channelId);
    return NextResponse.json({ batches });
  } catch (error) {
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
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId } = await params;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { error: "validation_failed", message: "Request body must be valid JSON" },
        { status: 400 }
      );
    }

    const parsedInput = parseWithSchema(createBatchInputSchema, { ...body, channelId }, "create batch input");

    // AGENTS.md §G / AC-DRYRUN-02: dry-run by default, and here unconditionally --
    // this Web UI never offers a live-execution action at all (no route calls the
    // live-execution service function), so a batch created through this endpoint can
    // never be anything other than a dry-run preview, regardless of the request body.
    const result = await core.createBatch({ ...parsedInput, dryRun: true });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
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
}
