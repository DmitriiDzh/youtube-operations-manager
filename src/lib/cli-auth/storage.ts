import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError } from "@/lib/video-metadata/contracts";

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

export function createActiveAuthStorage(baseDir = process.cwd()): ActiveAuthStorage {
  const dataDir = path.join(baseDir, "data");
  const contextPath = path.join(dataDir, "auth-context.json");

  async function ensureDataDir() {
    await mkdir(dataDir, { recursive: true });

    if (process.platform !== "win32") {
      try {
        await chmod(dataDir, 0o700);
      } catch {
        // Best effort on existing directories.
      }
    }
  }

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
      await ensureDataDir();

      const nextContext: ActiveAuthContext = {
        activeUserId: input.activeUserId,
        updatedAt: new Date().toISOString(),
        version: 1,
      };

      const tmpPath = path.join(dataDir, `.auth-context.${randomUUID()}.tmp`);
      await writeFile(tmpPath, JSON.stringify(nextContext, null, 2), {
        encoding: "utf8",
        mode: fsConstants.S_IRUSR | fsConstants.S_IWUSR,
      });

      if (process.platform !== "win32") {
        await chmod(tmpPath, 0o600);
      }

      await rename(tmpPath, contextPath);

      if (process.platform !== "win32") {
        await chmod(contextPath, 0o600);
      }

      return nextContext;
    },

    async clear() {
      await rm(contextPath, { force: true });
    },
  };
}
