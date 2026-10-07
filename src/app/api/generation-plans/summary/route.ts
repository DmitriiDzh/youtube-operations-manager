import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createGenerationPlansCore } from "@/lib/generation-plans";
import { planErrorResponse } from "../shared";

/** BL-143 phase 3 (AC-GP3-02): attempts waiting for the owner's verdict, for the Production badge. A local read. */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await createGenerationPlansCore().summary());
  } catch (error) {
    return planErrorResponse(error);
  }
}
