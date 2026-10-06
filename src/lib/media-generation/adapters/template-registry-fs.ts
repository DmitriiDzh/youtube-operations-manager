import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../contracts";
import { REGISTRY_FILE_MAX_BYTES, REGISTRY_TEMPLATE_FILE_PATTERN, TEMPLATE_INDEX_FILE } from "../template-registry";

// ---------------------------------------------------------------------------
// BL-132 (FACTORY_MEDIA_CONTROL_PLAN.md §2.3, ADR 0025) -- the ONE place YT Manager reads inside a logical path: the
// factory template registry folder (`media_templates`). Only `index.json` and `<templateId>.v<version>.json` directly in
// that folder are read; each must be a regular file whose real path is still a direct child of the folder's real path (a
// symlink out of the folder is refused) and at most REGISTRY_FILE_MAX_BYTES. Nothing is ever written there.
// ---------------------------------------------------------------------------

function unavailable(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError({ code: "media_template_registry_unavailable", message, details });
}

export function createTemplateRegistryReader(args: { resolveDir(): Promise<string> }) {
  return {
    async read(): Promise<{ indexText: string; readTemplateFile(name: string): Promise<string | null> }> {
      let dir: string;
      try {
        dir = await args.resolveDir();
      } catch (error) {
        throw unavailable(`The template registry folder (logical path media_templates) is not configured on this device: ${error instanceof Error ? error.message : String(error)}`);
      }
      let realDir: string;
      try {
        realDir = await realpath(dir);
        if (!(await stat(realDir)).isDirectory()) throw new Error("not a directory");
      } catch (error) {
        throw unavailable(`The template registry folder cannot be read: ${error instanceof Error ? error.message : String(error)}`, { path: dir });
      }

      async function readChild(name: string): Promise<string | null> {
        const candidate = path.join(realDir, name);
        let info;
        try {
          info = await lstat(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
        const real = info.isSymbolicLink() ? await realpath(candidate) : candidate;
        if (path.dirname(real) !== realDir) throw new Error(`${name} points outside the registry folder`);
        const target = await stat(real);
        if (!target.isFile()) throw new Error(`${name} is not a regular file`);
        if (target.size > REGISTRY_FILE_MAX_BYTES) throw new Error(`${name} is larger than ${REGISTRY_FILE_MAX_BYTES} bytes`);
        return readFile(real, "utf8");
      }

      let indexText: string | null;
      try {
        indexText = await readChild(TEMPLATE_INDEX_FILE);
      } catch (error) {
        throw unavailable(`${TEMPLATE_INDEX_FILE} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (indexText === null) throw unavailable(`${TEMPLATE_INDEX_FILE} is not in the template registry folder`);

      return {
        indexText,
        // A name outside the pattern is never read; an unreadable or unsafe file reads as "not there" (the template stays as installed).
        async readTemplateFile(name: string): Promise<string | null> {
          if (!REGISTRY_TEMPLATE_FILE_PATTERN.test(name)) return null;
          try {
            return await readChild(name);
          } catch {
            return null;
          }
        },
      };
    },
  };
}
