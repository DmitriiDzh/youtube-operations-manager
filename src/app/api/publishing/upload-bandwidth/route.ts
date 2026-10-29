import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { uploadBandwidthReport, uploadBandwidthStatus, type UploadBandwidthReport } from "@/lib/upload-bandwidth";

// BL-233 (FO-REQ-0047): whether a video upload on this computer is limited or paused for the live streams running here -- for the
// line on the stream page and on the uploads list. Read-only, in-process state; `upload: null` = no upload runner runs here.
export function createUploadBandwidthGetHandler(
  deps: { getSession: () => Promise<{ user?: { id?: string | null } } | null>; report: () => UploadBandwidthReport | null } = {
    getSession: () => getServerSession(authOptions),
    report: () => uploadBandwidthReport(uploadBandwidthStatus()),
  }
) {
  return async (): Promise<NextResponse> => {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ upload: deps.report() });
  };
}

export const GET = createUploadBandwidthGetHandler();
