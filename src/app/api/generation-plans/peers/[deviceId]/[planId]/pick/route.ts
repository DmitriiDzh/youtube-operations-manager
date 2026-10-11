import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createGenerationPlansCore, type GenerationPlanServices } from "@/lib/generation-plans";
import { activeChannelOf, planErrorResponse } from "../../../../shared";

export type PeerPickRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<GenerationPlanServices, "assertPeerPlanOfChannel" | "recordPeerPick">;
  activeChannelId: (userId: string) => Promise<string | null>;
};

/** BL-175 (VISUAL_REVIEW_PLAN.md §2.6): a pick action on another device's plan, carried there in this device's sync report. */
export function createPeerPickPostHandler(deps: PeerPickRouteDeps) {
  return async function POST(request: Request, context: { params: Promise<{ deviceId: string; planId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { deviceId, planId } = await context.params;
      // BL-157 (AC-SM-03): only a plan of the active channel.
      await deps.core.assertPeerPlanOfChannel(deviceId, planId, await deps.activeChannelId(userId));
      const body: unknown = await request.json().catch(() => ({}));
      const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      return NextResponse.json({ pick: await deps.core.recordPeerPick({ ...fields, deviceId, planId }) });
    } catch (error) {
      return planErrorResponse(error);
    }
  };
}

export const POST = createPeerPickPostHandler({
  getSession: () => getServerSession(authOptions),
  get core() {
    return createGenerationPlansCore();
  },
  activeChannelId: activeChannelOf,
});
