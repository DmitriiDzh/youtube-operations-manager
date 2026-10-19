import { createHash } from "node:crypto";

// Automerge's binary format (https://automerge.org/automerge-binary-format-spec/): a file is a run of chunks, each
// `magic(4) checksum(4) type(1) length(uLEB128) contents(length)`, where the checksum is the first 4 bytes of the sha256 of
// type + length + contents.
const MAGIC = [0x85, 0x6f, 0x4a, 0x83];

/**
 * BL-203/204 (docs/roadmap/plans/FAST_NAVIGATION_PLAN.md, stage 4): throws unless `bytes` is a run of whole, checksum-valid
 * Automerge chunks. `Automerge.load` used to reject a truncated peer file (Syncthing still copying it) by throwing;
 * `Automerge.loadIncremental`, which the merge now uses, silently ignores the incomplete tail instead -- this keeps the old
 * outcome: the peer is skipped and logged for this cycle, never treated as merged.
 */
export function assertCompleteAutomergeBytes(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new Error("The incoming draft document is empty");
  let offset = 0;
  while (offset < bytes.length) {
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[offset + i] !== MAGIC[i]) throw new Error("The incoming draft document is not an Automerge document (bad chunk header)");
    }
    const checksum = bytes.subarray(offset + 4, offset + 8);
    const typeAt = offset + 8;
    let length = 0;
    let shift = 0;
    let cursor = typeAt + 1;
    for (;;) {
      if (cursor >= bytes.length || shift > 49) throw new Error("The incoming draft document is incomplete (truncated chunk length)");
      const byte = bytes[cursor++]!;
      length += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    const end = cursor + length;
    if (end > bytes.length) throw new Error("The incoming draft document is incomplete (truncated, still being copied?)");
    const actual = createHash("sha256").update(bytes.subarray(typeAt, end)).digest().subarray(0, 4);
    if (Buffer.compare(Buffer.from(actual), Buffer.from(checksum)) !== 0) {
      throw new Error("The incoming draft document is corrupt (chunk checksum mismatch)");
    }
    offset = end;
  }
}
