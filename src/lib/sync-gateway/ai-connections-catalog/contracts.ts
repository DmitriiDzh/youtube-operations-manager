import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

/** The one constant key this whole document family is stored/synced under -- `ai_connections`
 * has no `channel_id` column at all (device/account-wide config, confirmed by reading
 * `src/lib/db.ts`'s schema), so unlike `change-drafts`/`editorial-profile` there is exactly ONE
 * document, never one per channel (`docs/roadmap/plans/FULL_DEVICE_HANDOFF_MIGRATION_PLAN.md`
 * §2 Category B / owner decision "отдельными документами"). */
export const GLOBAL_DOCUMENT_KEY = "global";

/**
 * One AI provider connection's non-secret config, as it lives inside the single global Automerge
 * document. Every field maps 1:1 onto `src/lib/db.ts`'s `ai_connections` columns EXCEPT the
 * encrypted credential itself (`ai_connection_credentials`, a separate table) -- that stays
 * device-local and is never part of this document, same reasoning as `users`/`cloud_connection`
 * (`AGENTS.md` §F).
 *
 * Known, accepted limitation (not solved here): `baseUrl` for a `localInferenceMode` connection
 * is only meaningfully reachable from the device that actually runs that local server --
 * syncing its metadata to another device is still useful (it shows the connection exists), but
 * that other device cannot necessarily use it. This is a pre-existing property of local-inference
 * connections in a multi-device world, not a new regression introduced by syncing -- before this
 * module, `ai_connections` did not sync at all, so nothing here makes the situation worse.
 */
export type AiConnectionEntry = {
  id: string;
  displayName: string;
  adapterType: string;
  baseUrl: string | null;
  modelId: string;
  localInferenceMode: boolean;
  enabled: boolean;
  status: string;
  statusMessage: string | null;
  statusCheckedAt: string | null;
  capabilitiesJson: string;
  assignedTasksJson: string;
  pricingJson: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiConnectionsDocument = {
  connections: Record<string, AiConnectionEntry>;
};

/** Every field two devices could realistically edit concurrently -- `id`/`createdAt` are set
 * once at creation and never revised again through this module's own API. */
export const AI_CONNECTION_MUTABLE_FIELDS = [
  "displayName",
  "baseUrl",
  "modelId",
  "localInferenceMode",
  "enabled",
  "status",
  "statusMessage",
  "statusCheckedAt",
  "capabilitiesJson",
  "assignedTasksJson",
  "pricingJson",
] as const satisfies readonly (keyof AiConnectionEntry)[];

export type FieldConflict = {
  connectionId: string;
  field: (typeof AI_CONNECTION_MUTABLE_FIELDS)[number];
  valuesByActor: Record<string, unknown>;
};

export type MergeResult = { newConflicts: FieldConflict[] };
