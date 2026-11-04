import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-225 (FO-REQ-0040, ADR 0051, docs/roadmap/plans/WEEKLY_PUBLISHING_PLAN.md stage 1): a channel's weekly publishing plans, the
// same on every computer. One Automerge document per channel. Both computers write it: agents' saves arrive on whichever computer
// their MCP session reaches, the owner's decisions on either. Plans, slots and decisions are three flat maps that exist from the
// genesis, so two computers that each start the same week merge instead of one plan replacing the other: a slot is assigned whole
// under `<weekStart>:<slotId>`, a decision under a fresh id, a plan's fields one by one. The meaning (validation, what is approved,
// vetoed or locked) is the publishing-plans module's; this family stores and carries.

export type PublishingPlanActor = "factory" | "worker";

/** A plan's own fields: its week (a Monday) and the time zone its slots' times are in. */
export type PublishingPlanMeta = {
  weekStart: string;
  /** IANA zone (`Asia/Tokyo`): the channel's time, in which every slot's `publishAt` is a wall time. */
  timeZone: string;
  createdAt: string;
  createdBy: PublishingPlanActor;
  updatedAt: string;
  updatedBy: PublishingPlanActor;
};

/** What the owner approves of a slot (ADR 0051 §3): every field of it, with the plan's time zone. */
export type PublishingPlanSlotContent = {
  date: string;
  /** Local wall time `YYYY-MM-DDTHH:MM` in the plan's `timeZone`. */
  publishAt: string;
  lengthHint: string | null;
  note: string | null;
  /**
   * BL-240 (ADR 0060): the slot this one replaces (a slot id of the same channel, any week). Present only when set: a slot written
   * before this field, or by a computer without it, has none.
   */
  replacesSlotId?: string;
};

export type PublishingPlanSlot = PublishingPlanSlotContent & {
  weekStart: string;
  slotId: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: PublishingPlanActor;
};

export type PublishingPlanDecisionKind = "approved" | "revoked" | "vetoed" | "restored";

/**
 * BL-242 (ADR 0062): a channel's approval stage -- `packaged` (the owner approves a slot's package; the default when the document
 * has none) or `slot` (the BL-225 behaviour: he approves the empty slot).
 */
export type PublishingPlanApprovalStage = "packaged" | "slot";

/** BL-242 (ADR 0062 §2): the package an approval names -- its video number, its manifest's SHA-256 and, once uploaded, its video id. */
export type PublishingPlanPackageFingerprint = { video: string; manifestSha256: string; videoId: string | null };

/** The owner's decision on one slot; never edited, the newest one of its pair counts (ADR 0051 §3, §5). */
export type PublishingPlanDecision = {
  id: string;
  weekStart: string;
  slotId: string;
  kind: PublishingPlanDecisionKind;
  /** The content hash of the slot the owner saw (with the plan's time zone then). */
  contentHash: string;
  /** That content, with the time zone: what «было …» shows after an agent's change. */
  snapshot: PublishingPlanSlotContent & { timeZone: string };
  by: "owner";
  device: string | null;
  at: string;
  /**
   * Review #7: one above the highest `seq` the deciding computer saw in the channel's document (a Lamport counter), so a decision
   * made after another orders after it whatever the computers' clocks say; `at` only breaks a tie. Absent on a decision written
   * before this field (it orders as 0).
   */
  seq?: number;
  /** BL-240 (ADR 0060): on a `vetoed` record written by the owner's approval of the slot that replaces this one: that slot's id. */
  replacedBy?: string;
  /**
   * BL-242 (ADR 0062 §2): on a decision made in the `packaged` stage, the package fingerprint the slot's hash was computed with.
   * Absent on a decision made in the `slot` stage (or before this field).
   */
  package?: PublishingPlanPackageFingerprint;
};

export type PublishingPlansDocument = {
  format: "ytm-publishing-plans";
  version: 1;
  channelId: string;
  /** By `weekStart`. */
  plans: Record<string, PublishingPlanMeta>;
  /** By `<weekStart>:<slotId>`. */
  slots: Record<string, PublishingPlanSlot>;
  /** By decision id. */
  decisions: Record<string, PublishingPlanDecision>;
  /** BL-242 (ADR 0062 §1): set only by the owner; absent = `packaged`. An older build ignores it. */
  approvalStage?: PublishingPlanApprovalStage;
};

/** The whole document as plain data (empty maps for a channel without a document yet). */
export type PublishingPlansSnapshot = Pick<PublishingPlansDocument, "plans" | "slots" | "decisions" | "approvalStage">;

/** One agent save, applied as one change: the plan made or updated, slots assigned whole, slots deleted. */
export type PublishingPlanChange = {
  weekStart: string;
  /** Set when the plan is new (its first save). */
  create: PublishingPlanMeta | null;
  /** A time zone to set on an existing plan (absent: kept). */
  timeZone?: string;
  updatedAt: string;
  updatedBy: PublishingPlanActor;
  upserts: PublishingPlanSlot[];
  removes: string[];
};

export const slotKey = (weekStart: string, slotId: string) => `${weekStart}:${slotId}`;

export type MergeResult = { newConflicts: [] };
