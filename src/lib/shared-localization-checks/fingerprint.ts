// BL-227 (ADR 0052): the fingerprint of a video's original title and description, stored when a change set is made and compared on
// read ("the original changed after this set was made"). Server-only (node:crypto); the checks in `index.ts` stay browser-safe.
import { createHash } from "node:crypto";

export function originalFingerprint(title: string, description: string): string {
  return createHash("sha256").update(`${title}\n${description}`, "utf8").digest("hex");
}
