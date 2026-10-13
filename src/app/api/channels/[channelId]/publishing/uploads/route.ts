import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createUploadApprovalCore, listChannelUploads, PUBLISHING_SETTING_FIELDS, type PublishingSettings } from "@/lib/publishing";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../../video-metadata/error-status";

type ApproveInput = {
  channelId: string;
  userId: string;
  items: Array<{ manifestPath: string; manifestSha256: string; publishAt: string | null }>;
  shownSettings: PublishingSettings;
  acknowledgeUnknownQuota?: boolean;
};

export type PublishingUploadsDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  list: (channelId: string) => Promise<unknown[]>;
  approve: (input: ApproveInput) => Promise<unknown>;
};

function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
  }
  return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
}

/** The request body's shape only; every rule of the approval itself is the publishing module's (`upload-approval.ts`). */
function parseBody(body: unknown): Omit<ApproveInput, "channelId" | "userId"> | null {
  if (body === null || typeof body !== "object") return null;
  const { items, shownSettings, acknowledgeUnknownQuota } = body as Record<string, unknown>;
  if (!Array.isArray(items) || shownSettings === null || typeof shownSettings !== "object") return null;
  const parsedItems = items.map((item) => {
    const { manifestPath, manifestSha256, publishAt } = (item ?? {}) as Record<string, unknown>;
    if (typeof manifestPath !== "string" || typeof manifestSha256 !== "string" || (publishAt !== null && typeof publishAt !== "string")) return null;
    return { manifestPath, manifestSha256, publishAt: publishAt as string | null };
  });
  if (parsedItems.some((item) => item === null)) return null;
  const settings = shownSettings as Record<string, unknown>;
  if (PUBLISHING_SETTING_FIELDS.some((field) => !(field in settings))) return null;
  return { items: parsedItems as ApproveInput["items"], shownSettings: settings as PublishingSettings, acknowledgeUnknownQuota: acknowledgeUnknownQuota === true };
}

/**
 * BL-182 stage 2 (FO-REQ-0023 §4 B4; ADR 0037 §3): GET -- the channel's uploads on this computer (queued, sending, finished) for the
 * progress list; POST -- the owner's approval of a selection of release packages, bound to the manifests and settings shown. The
 * approval only queues them; the background runner sends them, checking Live writes before every write. The active channel only.
 */
export function createPublishingUploadsHandlers(
  deps: PublishingUploadsDeps = {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    list: (channelId) => listChannelUploads(channelId),
    approve: (input) => createUploadApprovalCore().approve(input),
  }
) {
  return {
    async GET(_request: Request, { params }: { params: Promise<{ channelId: string }> }) {
      const session = await deps.getSession();
      const userId = session?.user?.id;
      if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        const { channelId } = await params;
        await deps.assertActiveChannel({ userId, channelId });
        return NextResponse.json({ uploads: await deps.list(channelId) });
      } catch (error) {
        return errorResponse(error);
      }
    },
    async POST(request: Request, { params }: { params: Promise<{ channelId: string }> }) {
      const session = await deps.getSession();
      const userId = session?.user?.id;
      if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      try {
        const { channelId } = await params;
        await deps.assertActiveChannel({ userId, channelId });
        const parsed = parseBody(await request.json().catch(() => null));
        if (!parsed) return NextResponse.json({ error: "validation_failed", message: "items (manifestPath, manifestSha256, publishAt) and shownSettings are required" }, { status: 400 });
        return NextResponse.json(await deps.approve({ channelId, userId, ...parsed }));
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

const handlers = createPublishingUploadsHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
