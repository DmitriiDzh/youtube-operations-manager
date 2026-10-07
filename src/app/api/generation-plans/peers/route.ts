import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createGenerationPlansCore } from "@/lib/generation-plans";
import { planErrorResponse } from "../shared";

/** BL-143 phase 2 (AC-GP2-06): the other devices' plans (read-only) and the verdicts this device sent them. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const core = createGenerationPlansCore();
    const [devices, outgoing] = await Promise.all([core.peerPlans(), core.outgoingVerdicts()]);
    return NextResponse.json({ devices, outgoing });
  } catch (error) {
    return planErrorResponse(error);
  }
}
