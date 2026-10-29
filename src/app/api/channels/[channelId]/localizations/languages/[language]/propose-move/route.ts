import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { DomainError } from "@/lib/changesets/contracts";
import { createChangeSetCore } from "@/lib/changesets";
import { createChannelAccessCore } from "@/lib/channel-access";
import { getVideoMetadataErrorStatus } from "../../../../../../video-metadata/error-status";

const core = createChangeSetCore();
const channelAccess = createChannelAccessCore();

/**
 * BL-232 (PRD-REQ-0043): the owner's «move this language to another code» (e.g. zh-Hans -> zh-CN) on every video of the channel that
 * has it. Only a PROPOSAL: a source:"deletion" Change Set (delete `language` + add `toLanguage` with the same text per video) that
 * still needs the owner's approval and a send through Batches -- nothing here writes to YouTube. Body: `{ toLanguage }`.
 */
export async function POST(request: Request, { params }: { params: Promise<{ channelId: string; language: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { channelId, language } = await params;
    await channelAccess.assertActiveChannel({ userId: session.user.id, channelId });
    const body = (await request.json().catch(() => null)) as { toLanguage?: unknown } | null;

    const result = await core.proposeLanguageMove(
      { channelId, fromLanguage: decodeURIComponent(language), toLanguage: body?.toLanguage },
      { createdBy: "owner" }
    );
    return NextResponse.json(result);
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
