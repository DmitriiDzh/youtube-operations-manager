import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createCloudConnectionCore } from "@/lib/cloud-connection";

/**
 * Read-only status for the Settings tab (`docs/decisions/0008-cloud-connection.md`). Never
 * includes a token -- `createCloudConnectionCore().getStatus()`'s public shape omits it entirely.
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const status = await createCloudConnectionCore().getStatus();
  return NextResponse.json(status);
}
