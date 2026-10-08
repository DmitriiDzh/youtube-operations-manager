import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createGenerationPlansCore } from "@/lib/generation-plans";
import { activeChannelOf, planErrorResponse } from "../shared";

/** BL-143 phase 2 (AC-GP2-06): the other devices' plans (read-only) and the verdicts this device sent them. */
export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const core = createGenerationPlansCore();
    const [devices, outgoing, channelId, claims] = await Promise.all([core.peerPlans(), core.outgoingVerdicts(), activeChannelOf(userId), core.peerClaims()]);
    // BL-157 (AC-SM-03, ADR 0004): only the active channel's plans of the other devices (the verdicts sent stay: by plan id).
    const plans = devices.map((d) => ({ ...d, plans: channelId ? d.plans.filter((p) => p.channelId === channelId) : [] }));
    // BL-157 (AC-TC-02): the other devices' live claims on those plans (the screen marks and skips them).
    const shown = new Set(plans.flatMap((d) => d.plans.map((p) => `${d.deviceId}\u0000${p.planId}`)));
    return NextResponse.json({ devices: plans, outgoing, claims: claims.filter((c) => shown.has(`${c.ownerDeviceId}\u0000${c.planId}`)) });
  } catch (error) {
    return planErrorResponse(error);
  }
}
