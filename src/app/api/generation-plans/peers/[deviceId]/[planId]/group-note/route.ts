import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createGenerationPlansCore, publishGenerationPlansShare, type GenerationPlanServices } from "@/lib/generation-plans";
import { activeChannelOf, planErrorResponse } from "../../../../shared";

export type PeerGroupNoteRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<GenerationPlanServices, "assertPeerPlanOfChannel" | "recordPeerGroupNote">;
  activeChannelId: (userId: string) => Promise<string | null>;
  publish: () => Promise<void>;
};

/**
 * BL-162 (FO-REQ-0013 §2.3, MEDIA_UX_REDESIGN_PLAN.md §5.2): the owner's wave note on another device's plan `{ groupId, note }`,
 * carried there in this device's report (version 3); that device applies it. Only a plan of the active channel (AC-SM-03).
 * The report goes out at once; a failure to publish never fails the note (it goes with the next report).
 */
export function createPeerGroupNotePostHandler(deps: PeerGroupNoteRouteDeps) {
  return async function POST(request: Request, context: { params: Promise<{ deviceId: string; planId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { deviceId, planId } = await context.params;
      await deps.core.assertPeerPlanOfChannel(deviceId, planId, await deps.activeChannelId(userId));
      const body: unknown = await request.json().catch(() => ({}));
      const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      const note = await deps.core.recordPeerGroupNote({ ...fields, deviceId, planId });
      void deps.publish().catch(() => undefined);
      return NextResponse.json({ note });
    } catch (error) {
      return planErrorResponse(error);
    }
  };
}

export const POST = createPeerGroupNotePostHandler({
  getSession: () => getServerSession(authOptions),
  get core() {
    return createGenerationPlansCore();
  },
  activeChannelId: activeChannelOf,
  publish: publishGenerationPlansShare,
});
