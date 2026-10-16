import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createChannelAccessCore } from "@/lib/channel-access";
import { createPackageComposerCore, type PackageDraft } from "@/lib/publishing";
import { DomainError } from "@/lib/shared-domain";
import { getVideoMetadataErrorStatus } from "../../../../video-metadata/error-status";

export type PackageDraftDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  assertActiveChannel: (args: { userId: string; channelId: string }) => Promise<void>;
  draft: (channelId: string, input: Record<string, unknown>) => Promise<PackageDraft>;
};

/** BL-192 (docs/roadmap/plans/NEW_RELEASE_PACKAGE_PLAN.md): the package as «Новый пакет» would save it from the folder (and the owner's edits), with the scan's problems. Read-only: nothing on disk changed. The active channel only. */
export function createPackageDraftHandler(
  deps: PackageDraftDeps = {
    getSession: () => getServerSession(authOptions),
    assertActiveChannel: async (args) => {
      await createChannelAccessCore().assertActiveChannel(args);
    },
    draft: (channelId, input) => createPackageComposerCore().draft(channelId, input),
  }
) {
  return async function POST(request: Request, { params }: { params: Promise<{ channelId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "The body must be JSON." }, { status: 400 });
    }
    if (!body || typeof body !== "object" || typeof (body as { folder?: unknown }).folder !== "string") {
      return NextResponse.json({ error: "validation_failed", message: "folder is required." }, { status: 400 });
    }
    try {
      const { channelId } = await params;
      await deps.assertActiveChannel({ userId, channelId });
      return NextResponse.json({ draft: await deps.draft(channelId, body as Record<string, unknown>) });
    } catch (error) {
      if (error instanceof DomainError) {
        return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      }
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}

export const POST = createPackageDraftHandler();
