import { link, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { BootstrapConfigError, bootstrapConfigSchema, type BootstrapConfig } from "./contracts";
import { writeJsonFileAtomic } from "@/lib/atomic-json-file";

/**
 * Device-local bootstrap configuration: which Syncthing-shared directory this device uses for
 * snapshot handoff, plus a stable per-device id. Uses the same shared atomic-write
 * implementation as `src/lib/cli-auth/adapters/active-auth-storage.ts` (`writeJsonFileAtomic`) rather than a
 * copy-pasted duplicate (found by independent review; AGENTS.md §D).
 */
export function createBootstrapConfigStore(configPath: string) {
  async function write(next: BootstrapConfig): Promise<BootstrapConfig> {
    // Defense in depth: validate against the same schema `read()` enforces before persisting,
    // rather than trusting every caller (e.g. an API route) to have already done so -- found by
    // independent review that a caller passing an empty `syncthingRootPath` (schema requires
    // non-empty) would previously persist it unvalidated and then brick every subsequent
    // read/write on this file (`BootstrapConfigError`, mapped to a 500 by the API layer).
    const parsed = bootstrapConfigSchema.safeParse(next);
    if (!parsed.success) {
      throw new BootstrapConfigError(`Refusing to persist invalid bootstrap config: ${parsed.error.message}`);
    }
    const validated = parsed.data;
    await writeJsonFileAtomic(configPath, validated);
    return validated;
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

  /**
   * Creates the config on first run if it doesn't exist yet; never overwrites silently.
   *
   * First-time creation is EXCLUSIVE (Phase 11 review round 2): the fresh config is written
   * atomically to a private temp path, then hard-linked into place, and `link` fails with EEXIST
   * if another caller created the file first. The loser then reads and returns the winner's
   * config. Previously this was read-then-write, so two concurrent first calls could each
   * generate a different `deviceId`, with the last rename winning. That silently orphaned any
   * data already keyed on the losing id (e.g. a `channel_workspaces` row).
   */
  async function ensureExists(): Promise<BootstrapConfig> {
    const existing = await read();
    if (existing) return existing;

    const now = new Date().toISOString();
    const candidate = bootstrapConfigSchema.parse({
      version: 1,
      deviceId: randomUUID(),
      syncthingRootPath: null,
      createdAt: now,
      updatedAt: now,
    });
    const tmpPath = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${randomUUID()}.create`);
    try {
      await writeJsonFileAtomic(tmpPath, candidate);
      try {
        await link(tmpPath, configPath);
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(tmpPath, { force: true });
    }

    const winner = await read();
    if (!winner) {
      throw new BootstrapConfigError("Bootstrap config disappeared during concurrent creation");
    }
    return winner;
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
