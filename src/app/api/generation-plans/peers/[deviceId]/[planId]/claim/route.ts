import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createGenerationPlansCore, publishGenerationPlansShare, type GenerationPlanServices } from "@/lib/generation-plans";
import { activeChannelOf, planErrorResponse } from "../../../../shared";

export type PeerClaimRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<GenerationPlanServices, "assertPeerPlanOfChannel" | "claimReview">;
  activeChannelId: (userId: string) => Promise<string | null>;
  publish: () => Promise<void>;
};

/**
 * BL-157 (AC-TC-01, AC-WV-06): "being reviewed here" on a track or a wave of ANOTHER device's plan, carried in this device's
 * report. A claim only on the active channel's plan (AC-SM-03); a release, which only removes this device's own claim, always.
 */
export function createPeerClaimPostHandler(deps: PeerClaimRouteDeps) {
  return async function POST(request: Request, context: { params: Promise<{ deviceId: string; planId: string }> }) {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const { deviceId, planId } = await context.params;
      const raw: unknown = await request.json().catch(() => ({}));
      const fields = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      if (fields.release !== true) await deps.core.assertPeerPlanOfChannel(deviceId, planId, await deps.activeChannelId(userId));
      const claim = await deps.core.claimReview({ ...fields, deviceId, planId });
      void deps.publish().catch(() => undefined);
      return NextResponse.json(claim);
    } catch (error) {
      return planErrorResponse(error);
    }
  };
}

export const POST = createPeerClaimPostHandler({
  getSession: () => getServerSession(authOptions),
  get core() {
    return createGenerationPlansCore();
  },
  activeChannelId: activeChannelOf,
  publish: publishGenerationPlansShare,
});
