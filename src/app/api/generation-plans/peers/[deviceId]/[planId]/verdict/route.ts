import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createGenerationPlansCore } from "@/lib/generation-plans";
import { planErrorResponse } from "../../../../shared";

/** BL-143 phase 2 (AC-GP2-03): the owner's verdict on another device's plan, carried there in this device's report. */
export async function POST(request: Request, context: { params: Promise<{ deviceId: string; planId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { deviceId, planId } = await context.params;
    const body: unknown = await request.json().catch(() => ({}));
    const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    return NextResponse.json({ verdict: await createGenerationPlansCore().recordPeerVerdict({ ...fields, deviceId, planId }) });
  } catch (error) {
    return planErrorResponse(error);
  }
}
