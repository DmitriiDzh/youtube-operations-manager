import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { createCloudConnectionCore } from "@/lib/cloud-connection";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await createCloudConnectionCore().disconnect();
  return NextResponse.json(await createCloudConnectionCore().getStatus());
}
