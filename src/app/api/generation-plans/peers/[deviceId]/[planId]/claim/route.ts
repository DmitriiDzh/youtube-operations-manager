import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createGenerationPlansCore, publishGenerationPlansShare } from "@/lib/generation-plans";
import { activeChannelOf, planErrorResponse } from "../../../../shared";

/** BL-157 (AC-TC-01, AC-WV-06): "being reviewed here" on a track or a wave of ANOTHER device's plan, carried in this device's report. */
export async function POST(request: Request, context: { params: Promise<{ deviceId: string; planId: string }> }) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { deviceId, planId } = await context.params;
    const core = createGenerationPlansCore();
    // BL-157 (AC-SM-03): only a plan of the active channel.
    await core.assertPeerPlanOfChannel(deviceId, planId, await activeChannelOf(userId));
    const body: unknown = await request.json().catch(() => ({}));
    const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const claim = await core.claimReview({ ...fields, deviceId, planId });
    void publishGenerationPlansShare().catch(() => undefined);
    return NextResponse.json(claim);
  } catch (error) {
    return planErrorResponse(error);
  }
}
