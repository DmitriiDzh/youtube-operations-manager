import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { insertVideoEditAuditEvent, rawSqlClient } from "@/lib/db";
import { assertDeviceAvailableForMutation } from "@/lib/device-mutation-gate";
import { createPackageReviewsCoreForProduction } from "@/lib/sync-gateway";
import { hashPackageFile } from "./adapters/files";
import type { OwnerReviewState } from "./contracts";
import { createPackageReviewsService, packageReviewsOwnerSurface, type PackageReviewsDeps, type PackageReviewsOwnerSurface } from "./services";

// BL-257 (ADR 0070): the package-reviews module of THIS server process. The write lock is one per process (keyed on globalThis: the
// routes are compiled separately). The channel's packages and their files come from the composition layer
// (`src/composition/package-reviews.ts`), so this module never imports the publishing module (AGENTS.md §M).
const LOCK_KEY = Symbol.for("ytom.packageReviews.lock");
type GlobalWithLock = typeof globalThis & { [LOCK_KEY]?: { queue: Promise<unknown> } };

function hostLabel(): string | null {
  try {
    return hostname() || null;
  } catch {
    return null;
  }
}

/** The ports the composition layer gives: the channel's packages, their files, and what happens after a change. */
export type PackageReviewsCompositionPorts = Pick<PackageReviewsDeps, "packages" | "resolveFile" | "afterChange" | "recodeAliases">;

function service(ports: PackageReviewsCompositionPorts) {
  const holder = globalThis as GlobalWithLock;
  const lock = (holder[LOCK_KEY] ??= { queue: Promise.resolve() });
  return createPackageReviewsService({
    store: createPackageReviewsCoreForProduction(),
    ...ports,
    hashFile: hashPackageFile,
    assertDeviceAvailable: () => assertDeviceAvailableForMutation(rawSqlClient),
    deviceLabel: async () => hostLabel(),
    now: () => new Date(),
    randomId: () => randomUUID().replace(/-/g, "").slice(0, 16),
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = lock.queue.then(fn, fn);
      lock.queue = run.catch(() => undefined);
      return run;
    },
    // The owner's decisions are audited on the computer they were made on (the synced record names the device for the other).
    audit: ({ channelId, video, detail }) => insertVideoEditAuditEvent({ channelId, videoId: `package:${video}`, eventType: "RESULT", detail }),
  });
}

/** The owner's surface: used only by the Web UI's package-review routes through the composition layer (AC-PR-08 source scan). */
export function createPackageReviewsOwnerCore(ports: PackageReviewsCompositionPorts): PackageReviewsOwnerSurface {
  return packageReviewsOwnerSurface(service(ports));
}

const NO_PACKAGES: PackageReviewsCompositionPorts = {
  packages: async () => ({ status: "no_workspace" }),
  resolveFile: async () => null,
  afterChange: () => undefined,
};

/**
 * The package scan's gate port (ADR 0070 §2): read-only, never throws -- no document is "off", a document that cannot be read is
 * "required, nothing approved" (AC-PR-07). BL-265: `recodeAliases` -- the caller's reader of the channel's BL-263 recode aliases
 * (video-projects, wired outside this module); absent -- exact video codes only.
 */
export function readOwnerReviewState(channelId: string, ports: Pick<PackageReviewsDeps, "recodeAliases"> = {}): Promise<OwnerReviewState> {
  return service({ ...NO_PACKAGES, ...ports }).ownerReviewState(channelId);
}

/**
 * Owner TG 4584 (BL-263 fix): the owner's latest decision on a Short's manifest carried to the manifest a local recode V -> S writes
 * (only an existing owner decision is copied, see `carryDecision`; BL-265: only a BL-257 decision keyed by the manifest alone -- one on
 * the mp4 follows the recode alias without a copy). Under the same per-process lock as the owner's decisions; throws
 * when the document cannot be read or written. Only `src/composition/release-recode.ts` calls it (boundaries.test.ts).
 */
export function carryReviewDecisionForRecode(channelId: string, input: { fromSha256: string; toSha256: string; video: string }): Promise<{ carried: "approved" | "returned" | null; wrote: boolean }> {
  return service(NO_PACKAGES).carryDecision(channelId, input);
}

export { createPackageReviewsService, packageReviewsOwnerSurface } from "./services";
export type { PackageReviewsDeps, PackageReviewsService, PackageReviewsOwnerSurface, PackageReviewsStore } from "./services";
export {
  decisionCovers,
  isMediaKeyed,
  latestOwnerDecision,
  ownerReviewProblemOf,
  ownerReviewStateOf,
  reviewGateOf,
  standingDecision,
  triedExceptionsOf,
  triedKeysOf,
  wellFormedDecision,
} from "./model";
export type { MediaKey, OwnerReviewProblem, TriedRuleRow } from "./model";
export * from "./contracts";
export * from "./schemas";
