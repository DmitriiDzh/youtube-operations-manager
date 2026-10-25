import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { PublishingPlanActor, PublishingPlansCore, PublishingPlanSlotContent } from "@/lib/sync-gateway";

export { DomainError, isDomainError };
export type { PublishingPlanActor, PublishingPlanSlotContent };

// ---------------------------------------------------------------------------
// BL-225 (FO-REQ-0040, docs/roadmap/plans/WEEKLY_PUBLISHING_PLAN.md, ADR 0051): a channel's weekly publishing plan -- slots with a
// date and a publish time in the channel's zone, drafted by agents over MCP, approved (the week at once or slot by slot) and vetoed
// by the owner in the Web UI. A feature module of its own (AGENTS.md §M): it depends on the publishing-plans sync family (its
// store), channel lookups and `zoned-time` -- never on `publishing`; what the uploads did to a slot (stages 2-3) comes in through
// the `progress` port the composition layer fills.
// ---------------------------------------------------------------------------

export const PUBLISHING_PLAN_LIMITS = {
  /** Slots in one plan (a week of up to four releases a day). */
  slots: 28,
  lengthHint: 40,
  note: 500,
} as const;

/**
 * FO-REQ-0040 item 6: where a slot stands. Stage 1 computes `planned` and `vetoed`; `built` / `packaged` (stage 2) and `uploading`
 * / `scheduled` / `published` / `failed` (stage 3) come from the `progress` port. `vetoed` wins over every other status.
 */
export const PLAN_SLOT_STATUSES = ["planned", "built", "packaged", "uploading", "scheduled", "published", "failed", "vetoed"] as const;
export type PlanSlotStatus = (typeof PLAN_SLOT_STATUSES)[number];

/** BL-225 stage 2: the release package that names the slot (`yt-release-package/2` `slotId`), as the plan screen shows it. */
export type PlanSlotPackage = {
  /** The channel's video number (`V64`). */
  video: string;
  title: string;
  durationSeconds: number;
  /** The translation languages the package carries (whether YouTube would take them is the package's own problem list). */
  languages: string[];
  /** The AI flag the upload will carry: the package's own, else the channel's publishing setting. */
  containsSyntheticMedia: boolean;
  /** The default thumbnail relative to the workspace (served by the publishing thumbnail route), or null when it is missing. */
  thumbnailPath: string | null;
  /** How many test thumbnails the package keeps for Test & Compare in Studio (never uploaded). */
  testThumbnails: number;
  /** The package's problems (codes), empty when ready. */
  problems: string[];
};

/** What the packages and uploads report for a slot (stages 2-3); null/absent: nothing yet. */
export type PlanSlotProgress = {
  status: Exclude<PlanSlotStatus, "planned" | "vetoed">;
  /** The failure code with `failed` (e.g. `thumbnail_failed`). */
  code: string | null;
  videoId: string | null;
  package?: PlanSlotPackage | null;
  /** Review #3: the date the uploaded video carries (UTC), if any: the slot is not released before it. */
  publishAt?: string | null;
};

/** Why an agent's save was refused, one entry per problem (`validation_failed`, `details.refused`). */
export type PlanSaveRefusal = {
  slotId?: string;
  field: "weekStart" | "timeZone" | "slots" | "date" | "publishAt" | "removeSlotIds";
  reason:
    | "week_start_invalid"
    | "week_start_not_monday"
    | "time_zone_required"
    | "time_zone_invalid"
    | "too_many_slots"
    | "duplicate_slot"
    | "date_invalid"
    | "outside_week"
    | "publish_at_invalid"
    | "date_mismatch"
    | "in_past"
    | "unknown_slot"
    | "slot_approved"
    // Review #2/#3: a slot id another week of the channel uses; removing a vetoed slot or one whose video is uploaded.
    | "slot_id_in_other_week"
    | "slot_vetoed"
    | "slot_uploaded";
};

export type PlanState = "empty" | "awaiting_approval" | "approved" | "past";

export type PlanSlotView = PublishingPlanSlotContent & {
  slotId: string;
  /** The instant of `publishAt` in the plan's zone (ISO, UTC). */
  publishAtUtc: string;
  /** SHA-256 of the slot's content with the plan's zone: what an approval names. */
  contentHash: string;
  approval: "approved" | "needs_approval";
  approvedAt: string | null;
  /**
   * The slot was approved, then changed (by an agent): the content the owner approved and when; the slot needs him again.
   * Null when the slot is approved, or was never approved.
   */
  changedAfterApproval: { previous: PublishingPlanSlotContent & { timeZone: string }; approvedAt: string; changedAt: string; changedBy: PublishingPlanActor } | null;
  vetoed: { at: string; device: string | null } | null;
  status: PlanSlotStatus;
  /** With `failed`: the code (stage 3). */
  statusCode: string | null;
  videoId: string | null;
  /** BL-225 stage 2: the package that names the slot, or null. */
  package: PlanSlotPackage | null;
  /** The slot's time has passed (it can no longer be approved, vetoed or restored). */
  released: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: PublishingPlanActor;
};

export type PlanSummary = {
  channelId: string;
  weekStart: string;
  /** The Sunday that ends the week. */
  weekEnd: string;
  timeZone: string;
  state: PlanState;
  counts: { slots: number; approved: number; needsApproval: number; vetoed: number };
  /** The earliest slot not vetoed (UTC), or null. */
  firstRelease: string | null;
  createdAt: string;
  createdBy: PublishingPlanActor;
  updatedAt: string;
  updatedBy: PublishingPlanActor;
};

export type PlanView = PlanSummary & { slots: PlanSlotView[] };

/** One local audit event per owner decision (`publishing_plan.approved` / `.revoked` / `.vetoed` / `.restored`). */
export type PlanAuditEntry = { channelId: string; weekStart: string; slotId: string; detail: Record<string, unknown> };

export type PublishingPlansPorts = {
  /** The sync family's operations the module uses (one document per channel, merged between the computers). */
  store: Pick<PublishingPlansCore, "read" | "savePlan" | "addDecisions">;
  /** Whether the channel is connected on this computer. */
  isChannelConnected(channelId: string): Promise<boolean>;
  /** This computer's name for decisions ("Mac", a host name), or null. */
  deviceLabel(): Promise<string | null>;
  now(): Date;
  /** A fresh random id part (letters, digits); the services prefix it. */
  randomId(): string;
  /** Write operations of one process run one at a time (read the plan, then write). */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** The owner's decisions, audited on this computer. */
  audit(entry: PlanAuditEntry): Promise<void>;
  /** Stages 2-3: what the packages and uploads say of the slots, by slotId. Absent: nothing (stage 1). */
  progress?(channelId: string, weekStart: string, slotIds: string[]): Promise<Map<string, PlanSlotProgress>>;
};

/**
 * BL-225 stage 3 (ADR 0051 §5, §7): what the uploads may do with a slot's video -- `approved` (schedule it at `publishAt`, UTC),
 * `vetoed` (never upload it; once uploaded, remove its date), `pending` (not approved now: upload it, if at all, without a date and
 * leave any date as it is). A slot id found in two plans is `pending` (ambiguous: nothing is scheduled by it).
 */
export type PlanSlotDecision = { kind: "approved"; publishAt: string } | { kind: "vetoed" } | { kind: "pending" };
