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
  const rawSyncthingRootPath = (body as { syncthingRootPath?: unknown } | null)?.syncthingRootPath;
  if (rawSyncthingRootPath !== null && typeof rawSyncthingRootPath !== "string") {
    return NextResponse.json(
      { error: "invalid_request", message: "syncthingRootPath must be a string or null" },
      { status: 400 }
    );
  }
  // `bootstrapConfigSchema` requires a non-empty string (z.string().min(1)) -- coerce an empty
  // string to `null` ("not configured") here, at the boundary, rather than letting it reach
  // `setSyncthingRootPath` and persist a value that fails validation on every subsequent read
  // (found by independent review: this previously bricked the whole device-handoff subsystem
  // with a 500 on every call until the on-disk JSON was manually fixed).
  const syncthingRootPath = rawSyncthingRootPath === "" ? null : rawSyncthingRootPath;

  try {
    const config = await bootstrapConfigStore.setSyncthingRootPath(syncthingRootPath);
    return NextResponse.json(config);
  } catch (error) {
    return deviceHandoffErrorResponse(error);
  }
}
