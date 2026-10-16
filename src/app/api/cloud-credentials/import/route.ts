import { NextResponse } from "next/server";
import { cloudCredentialsHandler, defaultCloudCredentialsRouteDeps, type CloudCredentialsRouteDeps } from "../shared";

// BL-193: `{ file, password }` -> `{ imported }` (each imported section's public view). Accepts BL-137's RunPod-only file too.
export function createCloudCredentialsImportPostHandler(deps: CloudCredentialsRouteDeps = defaultCloudCredentialsRouteDeps()) {
  return cloudCredentialsHandler(deps, async ({ transfer, body }) => NextResponse.json(await transfer.importFile(body)));
}

export const POST = createCloudCredentialsImportPostHandler();
