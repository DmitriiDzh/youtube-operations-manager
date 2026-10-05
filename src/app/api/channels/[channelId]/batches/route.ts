import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createBatchCore } from "@/lib/batches";
import { DomainError } from "@/lib/batches/contracts";
import { createBatchInputSchema, parseWithSchema } from "@/lib/batches/schemas";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getLiveWritesEnabled } from "@/lib/db";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";

const core = createBatchCore();
const channelAccess = createChannelAccessCore();

// Phase 5 Web UI/API (DEC-OQ-5: Web UI/API only, no CLI/MCP write tools). This route
// covers "select approved changes -> create a Batch -> inspect it" (AGENTS.md §G's
// dry-run-by-default requirement, AC-DRYRUN-02). Creating a batch with `dryRun: false`
// (a real, live batch) is only honored when the Settings-tab live-writes toggle is on
// (owner instruction, 2026-09-21) -- with the toggle off, `dryRun: false` in the request
// body is silently ignored and the batch is still forced dry-run, exactly as before this
// change. The sibling `execute` route is the only place that batch's real write can
// actually run, and only when the same toggle is still on at that later call (Layer 2,
// re-checked independently -- `write-path-inventory.test.ts` still enforces that no OTHER
// API/MCP/CLI file references a live-write-capable symbol).

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
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
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
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });

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

    // AGENTS.md §G / AC-DRYRUN-02: dry-run by default, and dry-run unconditionally unless
    // the Settings-tab live-writes toggle is on -- a request body cannot get a live batch
    // created while that toggle is off, regardless of what it asks for (fail closed).
    const liveWritesEnabled = await getLiveWritesEnabled();
    const dryRun = liveWritesEnabled ? (parsedInput.dryRun ?? true) : true;
    const result = await core.createBatch({ ...parsedInput, dryRun });

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
