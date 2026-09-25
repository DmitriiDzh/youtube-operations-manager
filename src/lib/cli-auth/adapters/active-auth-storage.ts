import { readFile, rm, stat } from "node:fs/promises";
import { z } from "zod";
import { DomainError } from "@/lib/video-metadata/contracts";
import { getProductionAppPaths } from "@/lib/platform-paths";
import { writeJsonFileAtomic } from "@/lib/atomic-json-file";

export const activeAuthContextSchema = z
  .object({
    activeUserId: z.string().min(1),
    updatedAt: z.string().datetime(),
    version: z.literal(1),
  })
  .strict();

export type ActiveAuthContext = z.infer<typeof activeAuthContextSchema>;

export type ActiveAuthStorage = {
  read(): Promise<ActiveAuthContext | null>;
  write(input: { activeUserId: string }): Promise<ActiveAuthContext>;
  clear(): Promise<void>;
};

/**
 * `contextPath` defaults to the platform-aware app-data location's `auth-context.json`
 * (docs/decisions/0002-additive-schema-versioning.md's companion task, "Pre-Release
 * Cross-Platform Persistence" -- replaces the previous `<cwd>/data/auth-context.json`
 * default). Tests inject an explicit isolated temp path, exactly as before.
 */
export function createActiveAuthStorage(
  contextPath: string = getProductionAppPaths().authContextPath
): ActiveAuthStorage {
  async function assertSafePermissions() {
    if (process.platform === "win32") return;

    const stats = await stat(contextPath);
    const mode = stats.mode & 0o777;

    if ((mode & 0o077) !== 0) {
      throw new DomainError({
        code: "AUTH_CALLBACK_INVALID",
        message: "Auth context file has insecure permissions",
        details: { expected: "0600", actual: mode.toString(8) },
      });
    }
  }

  return {
    async read() {
      try {
        await stat(contextPath);
      } catch {
        return null;
      }

      await assertSafePermissions();

      const raw = await readFile(contextPath, "utf8");
      const parsed = activeAuthContextSchema.safeParse(JSON.parse(raw));

      if (!parsed.success) {
        throw new DomainError({
          code: "AUTH_CALLBACK_INVALID",
          message: "Auth context file is invalid",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
            code: issue.code,
          })),
        });
      }

      return parsed.data;
    },

    async write(input) {
      const nextContext: ActiveAuthContext = {
        activeUserId: input.activeUserId,
        updatedAt: new Date().toISOString(),
        version: 1,
      };

      await writeJsonFileAtomic(contextPath, nextContext);

      return nextContext;
    },

    async clear() {
      await rm(contextPath, { force: true });
    },
  };
}
