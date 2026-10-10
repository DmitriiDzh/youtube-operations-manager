import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { writeFileAtomic } from "@/lib/atomic-json-file";
import { DomainError } from "../contracts";
import type { GeminiFilesPort, ResolvedInputFile } from "../services";

// BL-174 (GEMINI_MEDIA_PLAN.md §2.4): the module's file access. Inputs are read through ONE open descriptor whose identity
// (dev/ino) must match the file the workspace check proved contained -- a file swapped in after the check is refused (the
// same guard the S3 upload applies to media job inputs). Outputs go through the shared crash-safe write (tmp file, fsync,
// rename with the Windows retry), so a final name only ever holds a complete file.

export function createGeminiFiles(): GeminiFilesPort {
  return {
    async readInput(file: ResolvedInputFile, maxBytes: number): Promise<Buffer> {
      const handle = await open(file.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat();
        if (!info.isFile()) throw new DomainError({ code: "gemini_input_unavailable", message: "The input is not a regular file.", details: { reason: "not_a_file" } });
        if (file.identity && (info.dev !== file.identity.dev || info.ino !== file.identity.ino)) {
          throw new DomainError({ code: "gemini_input_unavailable", message: "The input file was replaced after it was checked.", details: { reason: "replaced" } });
        }
        if (info.size > maxBytes) throw new DomainError({ code: "gemini_input_unavailable", message: `The input is ${info.size} bytes, over ${maxBytes}.`, details: { reason: "too_large" } });
        return await handle.readFile();
      } finally {
        await handle.close();
      }
    },

    async writeOutput(filePath: string, data: Buffer): Promise<{ bytes: number; sha256: string }> {
      await writeFileAtomic(filePath, data);
      return { bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    },

    async writeManifest(filePath: string, manifest: unknown): Promise<void> {
      await writeFileAtomic(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}
