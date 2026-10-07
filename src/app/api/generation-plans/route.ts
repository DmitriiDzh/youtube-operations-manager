import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createGenerationPlansCore } from "@/lib/generation-plans";
import { planErrorResponse } from "./shared";

/** BL-143: this device's generation plans with their progress (`?status=active|completed|cancelled`). */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const status = new URL(request.url).searchParams.get("status") ?? undefined;
    return NextResponse.json({ plans: await createGenerationPlansCore().listPlans(status ? { status } : {}) });
  } catch (error) {
    return planErrorResponse(error);
  }
}
