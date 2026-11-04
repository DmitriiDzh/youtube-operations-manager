import { DomainError, isDomainError } from "@/lib/shared-domain";
import type { PublishingPlanActor, PublishingPlanApprovalStage, PublishingPlanPackageFingerprint, PublishingPlansCore, PublishingPlanSlotContent } from "@/lib/sync-gateway";

export { DomainError, isDomainError };
export type { PublishingPlanActor, PublishingPlanApprovalStage, PublishingPlanPackageFingerprint, PublishingPlanSlotContent };

/** BL-242 (ADR 0062 §1): the stage a document without `approvalStage` is in. */
export const DEFAULT_APPROVAL_STAGE: PublishingPlanApprovalStage = "packaged";

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
  /** BL-242 (ADR 0062 §2): the manifest file's SHA-256 (null when it could not be read): part of what the owner approves. */
  manifestSha256: string | null;
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
  field: "weekStart" | "timeZone" | "slots" | "date" | "publishAt" | "removeSlotIds" | "replacesSlotId";
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
    | "slot_uploaded"
    // BL-240 (ADR 0060): a removed vetoed slot's id stays taken; a slot cannot replace itself or a slot the channel does not have.
    | "slot_id_removed"
    | "replaces_self"
    | "replaces_unknown"
    | "replaces_cycle";
};

/** BL-240 (ADR 0060): the slot a slot replaces, as it stands now. */
export type ReplacedSlot = {
  slotId: string;
  /** The plan that holds it; null when not found. */
  weekStart: string | null;
  /** Its local wall time in its plan's zone; null when not found. */
  publishAt: string | null;
  /** The channel's video number of its package (`V66`), when the screen knows it. */
  video: string | null;
  vetoed: boolean;
  released: boolean;
  /** False: no slot with that id in the channel (any more). */
  found: boolean;
};

/** BL-242: `planned` -- in the `packaged` stage, nothing waits for the owner but a live future slot still waits for its package. */
export type PlanState = "empty" | "planned" | "awaiting_approval" | "approved" | "past";

export type PlanSlotView = PublishingPlanSlotContent & {
  slotId: string;
  /** The instant of `publishAt` in the plan's zone (ISO, UTC). */
  publishAtUtc: string;
  /**
   * SHA-256 of the slot's content with the plan's zone: what an approval names. BL-242 `packaged` stage: with the package
   * fingerprint appended (`fingerprint`); a slot waiting for its package shows the bare slot hash (it cannot be approved).
   */
  contentHash: string;
  /** BL-242: `awaiting_package` -- `packaged` stage, no ready or uploaded package yet: nothing for the owner to approve. */
  approval: "approved" | "needs_approval" | "awaiting_package";
  /** BL-242 (ADR 0062 §2): the package fingerprint `contentHash` was computed with (`packaged` stage), else null. */
  fingerprint: PublishingPlanPackageFingerprint | null;
  approvedAt: string | null;
  /**
   * The slot was approved, then changed (by an agent): the content the owner approved and when; the slot needs him again.
   * Null when the slot is approved, or was never approved.
   */
  changedAfterApproval: { previous: PublishingPlanSlotContent & { timeZone: string; package?: PublishingPlanPackageFingerprint }; approvedAt: string; changedAt: string; changedBy: PublishingPlanActor } | null;
  /** BL-240: the slot this one replaces (approving this one vetoes it), or null. */
  replaces: ReplacedSlot | null;
  /** `replacedBy`: vetoed by the owner's approval of that slot (BL-240), not by his own veto. */
  vetoed: { at: string; device: string | null; replacedBy?: string } | null;
  status: PlanSlotStatus;
  /** With `failed`: the code (stage 3). */
  statusCode: string | null;
  videoId: string | null;
  /** BL-225 stage 2: the package that names the slot, or null. */
  package: PlanSlotPackage | null;
  /**
   * BL-242 R3: the date the slot's uploaded video carries on YouTube (UTC), or null. Shown when the slot is not approved: a date left
   * by an approval that no longer counts, which the owner moves (approve) or removes (veto).
   */
  youtubePublishAt: string | null;
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
  /** BL-242 (ADR 0062 §1): the channel's approval stage (the same for every plan of the channel). */
  approvalStage: PublishingPlanApprovalStage;
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

/**
 * One local audit event per owner decision (`publishing_plan.approved` / `.revoked` / `.vetoed` / `.restored`); BL-242: the stage
 * change `publishing_plan.approval_stage` names no week and no slot (null).
 */
export type PlanAuditEntry = { channelId: string; weekStart: string | null; slotId: string | null; detail: Record<string, unknown> };

export type PublishingPlansPorts = {
  /** The sync family's operations the module uses (one document per channel, merged between the computers). */
  store: Pick<PublishingPlansCore, "read" | "savePlan" | "addDecisions" | "setApprovalStage">;
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
/**
 * BL-242 (ADR 0062 §3): in the `packaged` stage an approved slot carries the fingerprint the owner approved -- the uploads date only
 * that manifest (or, with a video id, that video); a vetoed slot carries the fingerprint of the approval it still stood on, so a
 * veto reaches the video a slot took over by its package (BL-242 D).
 */
export type PlanSlotDecision =
  | { kind: "approved"; publishAt: string; package?: PublishingPlanPackageFingerprint }
  | { kind: "vetoed"; package?: PublishingPlanPackageFingerprint }
  | { kind: "pending" };
