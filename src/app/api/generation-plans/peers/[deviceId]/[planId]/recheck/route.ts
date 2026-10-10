import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createGenerationPlansCore, type GenerationPlanServices } from "@/lib/generation-plans";
import { activeChannelOf, planErrorResponse } from "../../../../shared";

export type PeerRecheckRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<GenerationPlanServices, "assertPeerPlanOfChannel" | "recordPeerRecheckAnswer">;
  activeChannelId: (userId: string) => Promise<string | null>;
};

/**
 * BL-173 (PLAN_RECHECKS_PLAN.md §2.7): the owner's answer to an open re-check of another device's plan, carried there in this
 * device's sync report. Only a plan of the active channel (BL-157 AC-SM-03).
 */
export function createPeerRecheckPostHandler(deps: PeerRecheckRouteDeps) {
  return async function POST(request: Request, context: { params: Promise<{ deviceId: string; planId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { deviceId, planId } = await context.params;
      await deps.core.assertPeerPlanOfChannel(deviceId, planId, await deps.activeChannelId(userId));
      const body: unknown = await request.json().catch(() => ({}));
      const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
      return NextResponse.json({ verdict: await deps.core.recordPeerRecheckAnswer({ ...fields, deviceId, planId }) });
    } catch (error) {
      return planErrorResponse(error);
    }
  };
}

export const POST = createPeerRecheckPostHandler({
  getSession: () => getServerSession(authOptions),
  get core() {
    return createGenerationPlansCore();
  },
  activeChannelId: activeChannelOf,
});
