import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret, type EncryptedPayload } from "@/lib/shared-crypto";
import type { KeyFile } from "@/lib/device-key-file";
import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { DeviceSecretHints, DeviceSecretInfo, DeviceSecretName, DeviceSecretState, DeviceSecretStorePort, LegacySecretSource, StoredDeviceSecretRow } from "./contracts";

export type DeviceSecretsDeps = {
  store: DeviceSecretStorePort;
  /** The one key file (`device-secrets.key`); its `invalid` error is `encryption_key_not_configured`. */
  keyFile: KeyFile;
  /** ADR 0042 §3: where a slot's secret lived before this store (moved on first use, never read again once moved). */
  legacy?: Partial<Record<DeviceSecretName, LegacySecretSource>>;
  /** ADR 0042 §5: the legacy media key, to open session tokens sealed before this store. */
  legacySealKey?: () => Promise<Buffer | null>;
  now?: () => number;
};

function unreadable(name: string, detail: string): DomainError {
  return new DomainError({
    code: "device_secret_unreadable",
    message: `The stored ${name} secret cannot be read on this computer (${detail}). Enter it again.`,
    details: { name },
  });
}

/** An opaque token for one stored value: unique per save (the ciphertext carries a fresh IV), never the value itself. */
function versionOf(row: StoredDeviceSecretRow): string {
  return createHash("sha256").update(`${row.iv}:${row.ciphertext}`).digest("hex").slice(0, 32);
}

function infoOf(row: StoredDeviceSecretRow): DeviceSecretInfo {
  return { hints: row.hints, status: row.status, verifiedAt: row.verifiedAt, updatedAt: row.updatedAt, version: versionOf(row) };
}

/** BL-199 (ADR 0042): this computer's typed secrets. */
export function createDeviceSecrets(deps: DeviceSecretsDeps) {
  const now = deps.now ?? (() => Date.now());
  /** Slots whose legacy row cannot be opened (missing / unusable legacy key file): reported as `key_file_missing`. */
  const legacyUnreadable = new Set<DeviceSecretName>();
  /** Slots whose legacy row waits because THIS store's key file is unusable: reported as `key_file_invalid` (review of BL-199). */
  const legacyBlocked = new Set<DeviceSecretName>();
  const migrating = new Map<DeviceSecretName, Promise<void>>();

  async function keyState(): Promise<"ok" | "missing" | "invalid"> {
    try {
      return (await deps.keyFile.readKey()) ? "ok" : "missing";
    } catch (error) {
      if (isDomainError(error) && error.code === "encryption_key_not_configured") return "invalid";
      throw error;
    }
  }

  /**
   * ADR 0042 §3: moves a slot's legacy secret on first use -- written, read back, compared, then marked. Idempotent, one run per slot
   * at a time; `write`/`clear` wait for it, and it never writes over a row that exists by the time it would (review of BL-199).
   */
  function ensureMigrated(name: DeviceSecretName): Promise<void> {
    const running = migrating.get(name);
    if (running) return running;
    const run = (async () => {
      const source = deps.legacy?.[name];
      if (!source) return;
      if (await deps.store.isMigrated(name)) return;
      if (await deps.store.get(name)) {
        await deps.store.markMigrated(name, now());
        return;
      }
      const legacy = await source.read();
      if (legacy === "unreadable") {
        legacyUnreadable.add(name);
        return;
      }
      legacyUnreadable.delete(name);
      if (legacy) {
        // An unusable key file of this store: nothing can be written; reported, never thrown (the card must still render).
        if ((await keyState()) === "invalid") {
          legacyBlocked.add(name);
          return;
        }
        legacyBlocked.delete(name);
        const key = await deps.keyFile.readOrCreateKey();
        if (await deps.store.get(name)) {
          await deps.store.markMigrated(name, now());
          return;
        }
        await deps.store.upsert({ name, ...encryptSecret(legacy.plaintext, key), hints: legacy.hints, status: legacy.status, verifiedAt: legacy.verifiedAt, updatedAt: now() });
        const written = await deps.store.get(name);
        if (!written || decryptSecret(written, key) !== legacy.plaintext) throw unreadable(name, "the moved copy did not read back");
      }
      await deps.store.markMigrated(name, now());
    })().finally(() => migrating.delete(name));
    migrating.set(name, run);
    return run;
  }

  function slot(name: DeviceSecretName) {
    /** The secret and the version it was read at (for a later compare-and-set on exactly that value), or null. */
    async function readWithVersion(): Promise<{ value: string; version: string } | null> {
      await ensureMigrated(name);
      const row = await deps.store.get(name);
      if (!row) return null;
      const key = await deps.keyFile.readKey();
      if (!key) throw unreadable(name, "this computer's key file is missing");
      try {
        return { value: decryptSecret(row, key), version: versionOf(row) };
      } catch {
        throw unreadable(name, "it does not open with this computer's key file");
      }
    }

    return {
      name,

      async state(): Promise<DeviceSecretState> {
        await ensureMigrated(name);
        const row = await deps.store.get(name);
        if (!row) return legacyBlocked.has(name) ? "key_file_invalid" : legacyUnreadable.has(name) ? "key_file_missing" : "none";
        const key = await keyState();
        return key === "ok" ? "set" : key === "missing" ? "key_file_missing" : "key_file_invalid";
      },

      /** The plaintext hints and status; never the secret. Null when nothing is stored. */
      async info(): Promise<DeviceSecretInfo | null> {
        await ensureMigrated(name);
        const row = await deps.store.get(name);
        return row ? infoOf(row) : null;
      },

      /** The secret in clear for one call, or null when none is stored. A missing/unusable key file or a foreign row fails closed. */
      async read(): Promise<string | null> {
        return (await readWithVersion())?.value ?? null;
      },

      readWithVersion,

      /** Stores a new value (the key file is created on the first save); status and verifiedAt as given. */
      async write(plaintext: string, input: { hints: DeviceSecretHints; status?: string | null; verifiedAt?: number | null }): Promise<DeviceSecretInfo> {
        // A legacy move in flight must not land over this value afterwards.
        await ensureMigrated(name).catch(() => undefined);
        const key = await deps.keyFile.readOrCreateKey();
        await deps.store.upsert({ name, ...encryptSecret(plaintext, key), hints: input.hints, status: input.status ?? null, verifiedAt: input.verifiedAt ?? null, updatedAt: now() });
        // A value written here supersedes any legacy row for good.
        await deps.store.markMigrated(name, now());
        legacyUnreadable.delete(name);
        legacyBlocked.delete(name);
        const row = await deps.store.get(name);
        if (!row) throw unreadable(name, "the saved row is missing");
        return infoOf(row);
      },

      /** Compare-and-set on the version: a value saved meanwhile is never given another value's status. True when it changed. */
      async setStatus(expectedVersion: string, patch: { status?: string | null; verifiedAt?: number | null }): Promise<boolean> {
        const row = await deps.store.get(name);
        if (!row || versionOf(row) !== expectedVersion) return false;
        return deps.store.setStatus(name, row.ciphertext, patch);
      },

      /** Removes only this slot's row (and never brings a legacy row back); the shared key file goes only when it is unusable. */
      async clear(): Promise<void> {
        await ensureMigrated(name).catch(() => undefined);
        await deps.store.delete(name);
        await deps.store.markMigrated(name, now());
        legacyUnreadable.delete(name);
        legacyBlocked.delete(name);
        if ((await keyState()) === "invalid") await deps.keyFile.removeKey();
      },
    };
  }

  return {
    slot,

    /** Seals a short-lived secret (a session's proxy token) with this computer's key; null when no key file exists yet. */
    async seal(plaintext: string): Promise<EncryptedPayload | null> {
      const key = await deps.keyFile.readKey();
      return key ? encryptSecret(plaintext, key) : null;
    },

    /** Opens a sealed secret: this store's key first, then the legacy key it may have been sealed with (ADR 0042 §5); null if neither opens it. */
    async open(payload: EncryptedPayload): Promise<string | null> {
      for (const read of [() => deps.keyFile.readKey(), deps.legacySealKey ?? (async () => null)]) {
        let key: Buffer | null = null;
        try {
          key = await read();
        } catch {
          key = null;
        }
        if (!key) continue;
        try {
          return decryptSecret(payload, key);
        } catch {
          // not sealed with this key
        }
      }
      return null;
    },
  };
}

export type DeviceSecrets = ReturnType<typeof createDeviceSecrets>;
export type DeviceSecretSlot = ReturnType<DeviceSecrets["slot"]>;
