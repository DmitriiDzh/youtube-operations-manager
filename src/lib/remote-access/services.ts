import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { DomainError } from "@/lib/shared-domain";
import { DEFAULT_REMOTE_ACCESS_STATE, REMOTE_ACCESS_LIMITS, type RemoteAccessState, type RemoteAccessStatus } from "./contracts";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

export type RemoteAccessStore = { read(): Promise<string | null>; write(json: string): Promise<void> };
export type RemoteAccessDeps = { store: RemoteAccessStore; clock: { now(): number } };

/** Forgiving per field: a damaged file never opens remote access (enabled false, no password). */
export function stateFromJson(json: string | null): RemoteAccessState {
  let raw: Record<string, unknown> = {};
  try {
    raw = json ? (JSON.parse(json) as Record<string, unknown>) : {};
  } catch {
    raw = {};
  }
  const hex = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{32,256}$/.test(v) ? v : null);
  const hash = hex(raw.passwordHash);
  const salt = hex(raw.salt);
  return {
    enabled: raw.enabled === true && hash !== null && salt !== null,
    passwordHash: hash && salt ? hash : null,
    salt: hash && salt ? salt : null,
    epoch: Number.isInteger(raw.epoch) && (raw.epoch as number) > 0 ? (raw.epoch as number) : DEFAULT_REMOTE_ACCESS_STATE.epoch,
    ownerLogin: typeof raw.ownerLogin === "string" && raw.ownerLogin.length <= 320 ? raw.ownerLogin : null,
    failures: Array.isArray(raw.failures) ? raw.failures.filter((n): n is number => typeof n === "number").slice(-50) : [],
    lockedUntil: typeof raw.lockedUntil === "number" ? raw.lockedUntil : null,
  };
}

async function hashPassword(password: string, salt: Buffer): Promise<string> {
  return (await scrypt(password.normalize("NFC"), salt, 32)).toString("hex");
}

export function createRemoteAccessServices(deps: RemoteAccessDeps) {
  const now = () => deps.clock.now();
  // One writer at a time inside this process (a sign-in and a settings save must not lose each other's change).
  let tail: Promise<unknown> = Promise.resolve();
  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run, run);
    tail = result.catch(() => undefined);
    return result;
  }

  const load = async () => stateFromJson(await deps.store.read());
  const save = (s: RemoteAccessState) => deps.store.write(`${JSON.stringify(s, null, 2)}\n`);

  function statusOf(s: RemoteAccessState): RemoteAccessStatus {
    const locked = s.lockedUntil !== null && s.lockedUntil > now() ? new Date(s.lockedUntil).toISOString() : null;
    return { enabled: s.enabled, passwordSet: s.passwordHash !== null, ownerLogin: s.ownerLogin, lockedUntil: locked, epoch: s.epoch };
  }

  return {
    async state(): Promise<RemoteAccessState> {
      return load();
    },

    async status(): Promise<RemoteAccessStatus> {
      return statusOf(await load());
    },

    /** The owner sets a password on the Mac (AC-RA-4). Every older phone session stops working (epoch). */
    setPassword(password: unknown): Promise<RemoteAccessStatus> {
      return exclusive(async () => {
        if (typeof password !== "string" || [...password].length < REMOTE_ACCESS_LIMITS.minPasswordChars || password.length > REMOTE_ACCESS_LIMITS.maxPasswordChars) {
          throw new DomainError({ code: "validation_failed", message: `The password needs at least ${REMOTE_ACCESS_LIMITS.minPasswordChars} characters.`, details: { field: "password" } });
        }
        const s = await load();
        const salt = randomBytes(16);
        const next: RemoteAccessState = { ...s, passwordHash: await hashPassword(password, salt), salt: salt.toString("hex"), epoch: s.epoch + 1, failures: [], lockedUntil: null };
        await save(next);
        return statusOf(next);
      });
    },

    /** The switch. Off ends every phone session at once (AC-RA-6); on needs a password. Off also forgets the pinned login. */
    setEnabled(enabled: unknown): Promise<RemoteAccessStatus> {
      return exclusive(async () => {
        if (typeof enabled !== "boolean") throw new DomainError({ code: "validation_failed", message: "enabled: true or false", details: { field: "enabled" } });
        const s = await load();
        if (enabled && s.passwordHash === null) throw new DomainError({ code: "validation_failed", message: "Set a password first.", details: { field: "password" } });
        const next: RemoteAccessState = enabled ? { ...s, enabled: true } : { ...s, enabled: false, epoch: s.epoch + 1, ownerLogin: null };
        await save(next);
        return statusOf(next);
      });
    },

    /**
     * A remote sign-in's password check (AC-RA-4/5): switch on, not locked, right password (constant-time compare). Wrong ones
     * are counted in the file; at 5 in 15 minutes every attempt is refused for 15 minutes. Returns the session epoch.
     * `tailscaleLogin` (the proxy's header) is pinned on the first success and required to match afterwards.
     */
    verifyPassword(password: unknown, tailscaleLogin: string | null): Promise<{ epoch: number }> {
      return exclusive(async () => {
        const s = await load();
        const at = now();
        if (!s.enabled || s.passwordHash === null || s.salt === null) throw new DomainError({ code: "remote_access_disabled", message: "Access from other devices is turned off on the Mac." });
        if (s.lockedUntil !== null && s.lockedUntil > at) throw new DomainError({ code: "remote_access_locked", message: "Too many wrong passwords: try again later.", details: { lockedUntil: new Date(s.lockedUntil).toISOString() } });
        const given = typeof password === "string" && password.length <= REMOTE_ACCESS_LIMITS.maxPasswordChars ? await hashPassword(password, Buffer.from(s.salt, "hex")) : "";
        const ok = given.length === s.passwordHash.length && timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(s.passwordHash, "hex"));
        const loginOk = s.ownerLogin === null || (tailscaleLogin !== null && tailscaleLogin === s.ownerLogin);
        if (!ok || !loginOk) {
          const failures = [...s.failures.filter((t) => at - t < REMOTE_ACCESS_LIMITS.failureWindowMs), at];
          const locked = failures.length >= REMOTE_ACCESS_LIMITS.maxFailures ? at + REMOTE_ACCESS_LIMITS.lockMs : null;
          await save({ ...s, failures: locked ? [] : failures, lockedUntil: locked });
          throw new DomainError({ code: "remote_access_bad_password", message: ok ? "This Tailscale account is not the one this Mac trusts." : "Wrong password." });
        }
        await save({ ...s, failures: [], lockedUntil: null, ownerLogin: s.ownerLogin ?? tailscaleLogin });
        return { epoch: s.epoch };
      });
    },

    /** Is a phone session still good (AC-RA-6)? Switch on, same epoch, and the pinned Tailscale login when one is pinned. */
    async sessionValid(epoch: unknown, tailscaleLogin: string | null): Promise<boolean> {
      const s = await load();
      if (!s.enabled || typeof epoch !== "number" || epoch !== s.epoch) return false;
      return s.ownerLogin === null || tailscaleLogin === s.ownerLogin;
    },
  };
}

export type RemoteAccessServices = ReturnType<typeof createRemoteAccessServices>;
