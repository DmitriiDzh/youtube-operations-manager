import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createAiLocalizationCore } from "@/lib/ai-localization";
import { DomainError } from "@/lib/ai-localization/contracts";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { OperationLockError } from "@/lib/operation-lock";
import { RecoveryModeError } from "@/lib/device-handoff";

const core = createAiLocalizationCore();
const channelAccess = createChannelAccessCore();

// Phase 6, Slice 1: "generate localization proposals" + "validate output" steps of the
// AI Localization workflow. Read-only with respect to persistence -- generates
// proposals for review, never creates a Change/ChangeSet itself (see the
// change-sets/route.ts sibling for that step). Never calls a real, paid AI provider
// (docs/acceptance/PHASE_6_ACCEPTANCE.md AC-PROVIDER-01/AC-COST-01) and never touches
// the YouTube API.
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

    const result = await core.generateProposals({ ...body, channelId });
    return NextResponse.json(result);
  } catch (error) {
    // This route is the one place assertDeviceAvailable's OperationLockError/RecoveryModeError
    // (RISK-30, docs/TECHNICAL_DEBT.md) can reach an API route handler directly -- proxy.ts
    // exempts this specific path from its own blanket device-availability check, on the
    // understanding that the real-connection path enforces it itself deeper in the service
    // layer. Checked explicitly, the same way proxy.ts/mcp/server.ts/the CLI already do,
    // instead of falling through to a generic 500 that discards the stable code/details
    // (independent review, review series cycle 2 -- neither class extends DomainError, on
    // purpose, AGENTS.md §D).
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
