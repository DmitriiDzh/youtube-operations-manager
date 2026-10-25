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
};

export type PublishingPlanSlot = PublishingPlanSlotContent & {
  weekStart: string;
  slotId: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: PublishingPlanActor;
};

export type PublishingPlanDecisionKind = "approved" | "revoked" | "vetoed" | "restored";

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
};

/** The whole document as plain data (empty maps for a channel without a document yet). */
export type PublishingPlansSnapshot = Pick<PublishingPlansDocument, "plans" | "slots" | "decisions">;

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
