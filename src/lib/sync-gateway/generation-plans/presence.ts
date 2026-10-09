import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "@/lib/atomic-json-file";
import { createBootstrapConfigStore } from "@/lib/bootstrap-config";
import { getProductionAppPaths } from "@/lib/platform-paths/runtime";
import { sharedClaimSchema, type SharedClaim } from "./contracts";

// BL-162 (owner, Telegram 2026-10-09, msgs 2254 p.5 / 2259 / 2263; MEDIA_UX_REDESIGN_PLAN.md §5.4): "what is open on this
// computer right now" -- the review claims -- in a tiny file of its own next to the generation plans report, written the moment a
// claim changes and read straight from disk by the other computers' review screens. The report (up to 4 MB, read once a minute)
// made a claim known to the other computer only after 1-2 minutes; this file brings it to seconds. Each device writes only its
// own file; a file must name the device it is named after (one device never speaks for another).

export const REVIEW_PRESENCE_FORMAT = "ytm-review-presence";

export const reviewPresenceSchema = z
  .object({
    format: z.literal(REVIEW_PRESENCE_FORMAT),
    version: z.literal(1),
    deviceId: z.string().min(1).max(128),
    hostname: z.string().max(255).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
    claims: z.array(sharedClaimSchema).max(200),
  })
  .strict();

export type ReviewPresence = z.infer<typeof reviewPresenceSchema>;

/** A presence file larger than this is not read (it holds at most a few claims). */
export const REVIEW_PRESENCE_MAX_BYTES = 256 * 1024;

const FILE_RE = /^([a-zA-Z0-9_-]+)\.presence\.json$/;
const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");

export function createReviewPresence(deps: {
  /** The folder the presence files live in, and this device's id. */
  location(): Promise<{ dir: string; deviceId: string }>;
  clock?: { now(): Date };
}) {
  const now = () => deps.clock?.now() ?? new Date();
  return {
    /** Writes this device's claims, replacing its previous file. */
    async publish(input: { hostname: string | null; claims: SharedClaim[] }): Promise<void> {
      const { dir, deviceId } = await deps.location();
      await mkdir(dir, { recursive: true });
      const doc: ReviewPresence = { format: REVIEW_PRESENCE_FORMAT, version: 1, deviceId, hostname: input.hostname, updatedAt: now().toISOString(), claims: input.claims.slice(0, 200) };
      await writeFileAtomic(path.join(dir, `${sanitize(deviceId)}.presence.json`), new TextEncoder().encode(JSON.stringify(doc)));
    },

    /** Every other device's presence file that is well formed and speaks for the device it is named after. */
    async readPeers(): Promise<ReviewPresence[]> {
      const { dir, deviceId } = await deps.location();
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const own = sanitize(deviceId);
      const out: ReviewPresence[] = [];
      for (const entry of entries) {
        const match = FILE_RE.exec(entry);
        if (!match || match[1] === own) continue;
        try {
          const file = path.join(dir, entry);
          if ((await stat(file)).size > REVIEW_PRESENCE_MAX_BYTES) continue;
          const parsed = reviewPresenceSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
          if (parsed.success && sanitize(parsed.data.deviceId) === match[1]) out.push(parsed.data);
        } catch {
          // A file being written by Syncthing, or not JSON: skipped this time, read again on the next poll.
        }
      }
      return out;
    },
  };
}

export type ReviewPresenceCore = ReturnType<typeof createReviewPresence>;

/** Production: `<sync folder>/generation-plans/global/` (where the plans reports travel), or the local fallback folder. */
export function createReviewPresenceForProduction(): ReviewPresenceCore {
  const paths = getProductionAppPaths();
  const bootstrap = createBootstrapConfigStore(paths.bootstrapConfigPath);
  return createReviewPresence({
    async location() {
      const config = await bootstrap.ensureExists();
      // Review: a configured sync folder that is missing (an unmounted drive, a deleted share) is never created here -- the
      // same guard every other sync writer applies (`checkRootAvailable`); the caller treats the throw as "no presence now".
      if (config.syncthingRootPath && !(await stat(config.syncthingRootPath).then((s) => s.isDirectory(), () => false))) {
        throw new Error(`Sync folder is not available: ${config.syncthingRootPath}`);
      }
      const root = config.syncthingRootPath ? path.join(config.syncthingRootPath, "generation-plans") : paths.generationPlansSyncFallbackDir;
      return { dir: path.join(root, "global"), deviceId: config.deviceId };
    },
  });
}
