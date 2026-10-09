import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createGenerationPlansCore } from "@/lib/generation-plans";
import { activeChannelOf, planErrorResponse } from "./shared";

/** BL-143: this device's generation plans of the active channel with their progress (`?status=active|completed|cancelled`). */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const status = new URL(request.url).searchParams.get("status") ?? undefined;
    // BL-157 (AC-SM-03, ADR 0004): Media lists only the active channel's plans; none while no channel is active.
    const channelId = await activeChannelOf(userId);
    if (!channelId) return NextResponse.json({ plans: [] });
    return NextResponse.json({ plans: await createGenerationPlansCore().listPlans({ ...(status ? { status } : {}), channelId }, { ownerView: true }) });
  } catch (error) {
    return planErrorResponse(error);
  }
}
