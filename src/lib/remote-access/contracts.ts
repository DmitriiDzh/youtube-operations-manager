// BL-251 (owner msgs 4210/4214/4219, docs/roadmap/plans/REMOTE_ACCESS_PLAN.md, ADR 0067): YT Manager from the owner's own
// devices over his Tailscale network. The server keeps listening on 127.0.0.1; `tailscale serve` is the only way in from
// outside this Mac. This module decides what a request from outside may do, and holds the switch and the password.

export const REMOTE_ACCESS_LIMITS = Object.freeze({
  minPasswordChars: 8,
  maxPasswordChars: 200,
  /** Wrong passwords counted in this window; at maxFailures every attempt is refused for lockMs. */
  failureWindowMs: 15 * 60_000,
  maxFailures: 5,
  lockMs: 15 * 60_000,
  /** A phone session lasts this long, then the password is asked again. */
  sessionMaxAgeSec: 30 * 24 * 60 * 60,
});

/** What is stored on THIS Mac only (a file in the app-data folder, never in the database a device handoff copies). */
export type RemoteAccessState = {
  enabled: boolean;
  /** scrypt(password, salt), hex; null = no password set (remote access cannot be used). */
  passwordHash: string | null;
  salt: string | null;
  /** Bumped on every password change and every switch-off: older phone sessions stop working at once. */
  epoch: number;
  /** The Tailscale login of the first successful remote sign-in; later remote requests must carry the same one. */
  ownerLogin: string | null;
  failures: number[];
  lockedUntil: number | null;
};

export const DEFAULT_REMOTE_ACCESS_STATE: RemoteAccessState = Object.freeze({
  enabled: false,
  passwordHash: null,
  salt: null,
  epoch: 1,
  ownerLogin: null,
  failures: [],
  lockedUntil: null,
}) as RemoteAccessState;

/** What the Settings card and any API answer may show: never the hash or the salt. */
export type RemoteAccessStatus = { enabled: boolean; passwordSet: boolean; ownerLogin: string | null; lockedUntil: string | null; epoch: number };
