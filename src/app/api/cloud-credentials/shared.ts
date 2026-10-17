import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { getVideoMetadataErrorStatus } from "@/app/api/video-metadata/error-status";
import { authOptions } from "@/lib/auth";
import { createCloudCredentialsTransferForProduction, type CloudCredentialsTransfer } from "@/lib/cloud-credentials-transfer";
import { isDomainError } from "@/lib/shared-domain";

// BL-193 (ADR 0039 §6): the owner's routes for the one cloud-keys file (Settings → Cloud APIs). Web session required (401); Web UI
// only -- no MCP, Factory or agent tool exports or imports keys (ADR 0027 §3). No response ever carries a key or the password.

export type CloudCredentialsRouteDeps = {
  getSession: () => Promise<{ user?: { id?: string | null } } | null>;
  transfer: Pick<CloudCredentialsTransfer, "exportFile" | "importFile">;
};

export function defaultCloudCredentialsRouteDeps(): CloudCredentialsRouteDeps {
  return {
    getSession: () => getServerSession(authOptions),
    get transfer() {
      return createCloudCredentialsTransferForProduction();
    },
  };
}

export function cloudCredentialsHandler(deps: CloudCredentialsRouteDeps, run: (args: { transfer: CloudCredentialsRouteDeps["transfer"]; body: unknown }) => Promise<NextResponse>) {
  return async function handler(request: Request): Promise<NextResponse> {
    const session = await deps.getSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "validation_failed", message: "Request body must be valid JSON" }, { status: 400 });
    }
    try {
      return await run({ transfer: deps.transfer, body });
    } catch (error) {
      if (isDomainError(error)) return NextResponse.json({ error: error.code, message: error.message, details: error.details }, { status: getVideoMetadataErrorStatus(error.code) });
      return NextResponse.json({ error: "internal_error", message: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
    }
  };
}
