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
    const [devices, outgoing, channelId] = await Promise.all([core.peerPlans(), core.outgoingVerdicts(), activeChannelOf(userId)]);
    // BL-157 (AC-SM-03, ADR 0004): only the active channel's plans of the other devices (the verdicts sent stay: by plan id).
    return NextResponse.json({ devices: devices.map((d) => ({ ...d, plans: channelId ? d.plans.filter((p) => p.channelId === channelId) : [] })), outgoing });
  } catch (error) {
    return planErrorResponse(error);
  }
}
