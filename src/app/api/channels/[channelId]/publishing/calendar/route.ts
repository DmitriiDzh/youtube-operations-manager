import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createPublishingCalendarCore, type PublishingCalendarResult } from "@/lib/publishing";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../../video-metadata/error-status";

export type PublishingCalendarDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  getCalendar: (input: { channelId: string }) => Promise<PublishingCalendarResult>;
};

/**
 * BL-182 stage 1 (FO-REQ-0023 §4 C): the active channel's publishing calendar -- published, scheduled, overdue and undated videos
 * with the coverage and the data age. A local read: never a YouTube call; the caller's active channel only (AGENTS.md §F).
 */
export function createPublishingCalendarHandler(
  deps: PublishingCalendarDeps = {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    getCalendar: (input) => createPublishingCalendarCore().getCalendar(input),
  }
) {
  return async function GET(_request: Request, { params }: { params: Promise<{ channelId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { channelId } = await params;
      await deps.assertActiveChannel({ userId, channelId });
      return NextResponse.json(await deps.getCalendar({ channelId }));
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const GET = createPublishingCalendarHandler();
