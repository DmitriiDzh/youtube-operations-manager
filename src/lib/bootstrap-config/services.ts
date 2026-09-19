import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BootstrapConfigError, bootstrapConfigSchema, type BootstrapConfig } from "./contracts";

/**
 * Device-local bootstrap configuration: which Syncthing-shared directory this device uses for
 * snapshot handoff, plus a stable per-device id. Mirrors src/lib/cli-auth/storage.ts's atomic
 * tmp-write-then-rename pattern and Windows/POSIX permission handling (reused shape, not
 * reinvented, per docs/DEVELOPMENT_PLAYBOOK.md §6.2).
 */
export function createBootstrapConfigStore(configPath: string) {
  const dir = path.dirname(configPath);

  async function ensureDir() {
    await mkdir(dir, { recursive: true });
    if (process.platform !== "win32") {
      try {
        await chmod(dir, 0o700);
      } catch {
        // Best effort on an already-existing directory.
      }
    }
  }

  async function write(next: BootstrapConfig): Promise<BootstrapConfig> {
    await ensureDir();
    const tmpPath = path.join(dir, `.bootstrap-config.${randomUUID()}.tmp`);
    await writeFile(tmpPath, JSON.stringify(next, null, 2), {
      encoding: "utf8",
      mode: fsConstants.S_IRUSR | fsConstants.S_IWUSR,
    });
    if (process.platform !== "win32") {
      await chmod(tmpPath, 0o600);
    }
    await rename(tmpPath, configPath);
    if (process.platform !== "win32") {
      await chmod(configPath, 0o600);
    }
    return next;
  }

  async function read(): Promise<BootstrapConfig | null> {
    try {
      await stat(configPath);
    } catch {
      return null;
    }

    const raw = await readFile(configPath, "utf8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new BootstrapConfigError("Bootstrap config file is not valid JSON");
    }

    const parsed = bootstrapConfigSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new BootstrapConfigError(
        `Bootstrap config file failed validation: ${parsed.error.message}`
      );
    }
    return parsed.data;
  }

  /** Creates the config on first run if it doesn't exist yet; never overwrites silently. */
  async function ensureExists(): Promise<BootstrapConfig> {
    const existing = await read();
    if (existing) return existing;

    const now = new Date().toISOString();
    return write({
      version: 1,
      deviceId: randomUUID(),
      syncthingRootPath: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  async function setSyncthingRootPath(
    syncthingRootPath: string | null
  ): Promise<BootstrapConfig> {
    const existing = await ensureExists();
    return write({
      ...existing,
      syncthingRootPath,
      updatedAt: new Date().toISOString(),
    });
  }

  return { read, ensureExists, setSyncthingRootPath };
}

export type BootstrapConfigStore = ReturnType<typeof createBootstrapConfigStore>;
