import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { getOperationLock } from "@/lib/operation-lock";
import { isDeviceInRecoveryMode } from "@/lib/device-handoff";
import { readLineageState, scanForUnresolvedExecutionState } from "@/lib/snapshot";
import { rawSqlClient, deviceHandoffErrorResponse } from "../shared";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [lock, recoveryMode, unresolved, lineage] = await Promise.all([
      getOperationLock(rawSqlClient),
      isDeviceInRecoveryMode(rawSqlClient),
      scanForUnresolvedExecutionState(rawSqlClient),
      readLineageState(rawSqlClient),
    ]);

    return NextResponse.json({ lock, recoveryMode, unresolved, lineage });
  } catch (error) {
    return deviceHandoffErrorResponse(error);
  }
}
