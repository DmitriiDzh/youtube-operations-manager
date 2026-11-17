import { createHash } from "node:crypto";

/** BL-269: the SHA-256 (lower-case hex) of the exact bytes the writer sends and the package states. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
