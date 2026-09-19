import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { acknowledgeRecoveryDiagnostics, isDeviceInRecoveryMode } from "@/lib/device-handoff";
import { rawSqlClient, deviceHandoffErrorResponse } from "../shared";

/**
 * Read-only/informational operator action (see src/lib/device-handoff/services.ts's own doc
 * comment): records that the diagnostics were reviewed. Never changes any row's status, never
 * authorizes retry, never itself lifts the recovery-mode gate -- the response's
 * `recoveryModeStillActive` is computed fresh, after the acknowledgement, to make that
 * explicit rather than implied.
 */
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let note: string | undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as { note?: unknown };
    if (typeof body.note === "string") note = body.note;
  } catch {
    // no body is fine
  }

  try {
    const result = await acknowledgeRecoveryDiagnostics(rawSqlClient, { note });
    const recoveryModeStillActive = await isDeviceInRecoveryMode(rawSqlClient);
    return NextResponse.json({ ...result, recoveryModeStillActive });
  } catch (error) {
    return deviceHandoffErrorResponse(error);
  }
}
