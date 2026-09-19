import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { bootstrapConfigStore, deviceHandoffErrorResponse } from "../shared";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const config = await bootstrapConfigStore.ensureExists();
    return NextResponse.json(config);
  } catch (error) {
    return deviceHandoffErrorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "Body must be JSON" }, { status: 400 });
  }
  const syncthingRootPath = (body as { syncthingRootPath?: unknown } | null)?.syncthingRootPath;
  if (syncthingRootPath !== null && typeof syncthingRootPath !== "string") {
    return NextResponse.json(
      { error: "invalid_request", message: "syncthingRootPath must be a string or null" },
      { status: 400 }
    );
  }

  try {
    const config = await bootstrapConfigStore.setSyncthingRootPath(syncthingRootPath);
    return NextResponse.json(config);
  } catch (error) {
    return deviceHandoffErrorResponse(error);
  }
}
