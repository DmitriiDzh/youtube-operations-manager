import { NextResponse } from "next/server";
import { cloudCredentialsHandler, defaultCloudCredentialsRouteDeps, type CloudCredentialsRouteDeps } from "../shared";

// BL-193 (ADR 0039 §6; BL-137 before it): `{ password }` -> `{ file, skipped }`: every cloud key of this computer in one file
// encrypted under the password. The response carries only ciphertext and the public hints, never a key.
export function createCloudCredentialsExportPostHandler(deps: CloudCredentialsRouteDeps = defaultCloudCredentialsRouteDeps()) {
  return cloudCredentialsHandler(deps, async ({ transfer, body }) => NextResponse.json(await transfer.exportFile(body), { headers: { "cache-control": "no-store" } }));
}

export const POST = createCloudCredentialsExportPostHandler();
