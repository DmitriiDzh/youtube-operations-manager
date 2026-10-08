import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createGenerationPlansCore, type GenerationPlanServices } from "@/lib/generation-plans";
import { activeChannelOf, planErrorResponse } from "../shared";

export type PeersRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  core: Pick<GenerationPlanServices, "peerPlans" | "outgoingVerdicts" | "peerClaims">;
  activeChannelId: (userId: string) => Promise<string | null>;
};

/**
 * BL-143 phase 2 (AC-GP2-06): the other devices' plans (read-only) and the verdicts this device sent them. BL-157 (AC-SM-03,
 * ADR 0004/0031): only the ACTIVE channel's -- the plans, the verdicts sent from here and the other devices' claims alike
 * (a verdict names another channel's track as much as a plan does); none while no channel is active.
 */
export function createPeersGetHandler(deps: PeersRouteDeps) {
  return async function GET() {
    const session = await deps.getSession();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const [devices, outgoing, channelId, claims] = await Promise.all([deps.core.peerPlans(), deps.core.outgoingVerdicts(), deps.activeChannelId(userId), deps.core.peerClaims()]);
      const plans = devices.map((d) => ({ ...d, plans: channelId ? d.plans.filter((p) => p.channelId === channelId) : [] }));
      const shown = new Set(plans.flatMap((d) => d.plans.map((p) => `${d.deviceId}\u0000${p.planId}`)));
      return NextResponse.json({
        devices: plans,
        outgoing: outgoing.filter((v) => shown.has(`${v.ownerDeviceId}\u0000${v.planId}`)),
        claims: claims.filter((c) => shown.has(`${c.ownerDeviceId}\u0000${c.planId}`)),
      });
    } catch (error) {
      return planErrorResponse(error);
    }
  };
}

export const GET = createPeersGetHandler({
  getSession: () => getServerSession(authOptions),
  get core() {
    return createGenerationPlansCore();
  },
  activeChannelId: activeChannelOf,
});
