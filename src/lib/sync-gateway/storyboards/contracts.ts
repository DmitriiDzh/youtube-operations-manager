import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// BL-184 (FO-REQ-0024, ADR 0038, docs/roadmap/plans/STORYBOARD_PLAN.md §2): a channel's storyboards, the same on every computer. One
// Automerge document per channel. Both computers write it: versions come from the Operator's Factory API, comments and decisions
// from the owner on either computer. Everything two computers can add is a map entry under a fresh id, and a version is assigned
// whole and never edited, so appends never collide. The meaning (validation, the derived state, what counts as current) is the
// storyboards module's; this family stores and carries.

export type StoryboardKeyframe = {
  id: string;
  /** Relative to the channel's `99 Data Exchange` folder (`Sent to YTM/...` or `From YTM/...`). */
  file: string;
  /** Frozen when the version was made: the file each computer shows is checked against it. */
  sha256: string;
  bytes: number;
  caption: string | null;
  /** The keyframe it was made from (lineage), if any. */
  parentKeyframeId: string | null;
};

export type StoryboardSegment = {
  id: string;
  fromKeyframeId: string;
  toKeyframeId: string;
  action: string;
  durationSeconds: number;
  model: string | null;
  settings: Record<string, string | number | boolean>;
  estimateUsd: number | null;
};

export type StoryboardProp = { id: string; name: string; kind: "object" | "character"; cells: Record<string, string> };

export type StoryboardVersion = {
  number: number;
  createdAt: string;
  title: string;
  loop: boolean;
  keyframes: StoryboardKeyframe[];
  segments: StoryboardSegment[];
  props: StoryboardProp[];
  notes: string | null;
};

export type StoryboardCommentTarget =
  | { kind: "storyboard" }
  | { kind: "keyframe"; keyframeId: string; region: { x: number; y: number; r: number } | null }
  | { kind: "segment"; segmentId: string }
  | { kind: "prop"; propId: string; keyframeId: string };

export type StoryboardAuthor = "owner" | "operator";

export type StoryboardReply = { id: string; author: StoryboardAuthor; device: string | null; text: string; createdAt: string };

export type StoryboardComment = {
  id: string;
  /** The version the comment was made on (older comments stay readable with their version). */
  versionNumber: number;
  target: StoryboardCommentTarget;
  author: StoryboardAuthor;
  device: string | null;
  text: string;
  createdAt: string;
  state: "open" | "resolved";
  stateChangedAt: string | null;
  stateChangedBy: StoryboardAuthor | null;
  replies: Record<string, StoryboardReply>;
};

/** The owner's decision on one version; it counts only while that version is the latest (ADR 0038 §2). */
export type StoryboardDecision = {
  id: string;
  kind: "approved" | "changes_requested";
  versionNumber: number;
  by: string;
  device: string | null;
  at: string;
  note: string | null;
};

/**
 * BL-184 stage 3 (FO-REQ-0024 B5): the owner's pick of one take (a video job) for a segment of a version -- a media (GPU) job or a
 * Gemini job that rendered that segment. Assigned whole; the last pick from either computer wins.
 */
export type StoryboardPick = { source: "media" | "gemini"; jobId: string; device: string | null; at: string };

export type StoryboardRecord = {
  id: string;
  createdAt: string;
  createdBy: "operator" | "producer";
  planId: string | null;
  /** By version number as a string ("1", "2", ...). */
  versions: Record<string, StoryboardVersion>;
  /** By version number: when the Operator put that version in review. */
  submissions: Record<string, { at: string }>;
  decisions: Record<string, StoryboardDecision>;
  comments: Record<string, StoryboardComment>;
  /** BL-184 stage 3: by version number, then segment id (absent = no pick yet). */
  picks?: Record<string, Record<string, StoryboardPick>>;
};

/**
 * BL-184 stage 2 (FO-REQ-0024 B4, owner 1183): the channel's setting "a first/last-frame video from two different images needs an
 * approved storyboard". Absent = on (the default); assigned whole, so the last change from either computer wins.
 */
export type StoryboardGateSetting = { requireApproved: boolean; changedAt: string; changedBy: string | null };

export type StoryboardsDocument = {
  format: "ytm-storyboards";
  version: 1;
  channelId: string;
  storyboards: Record<string, StoryboardRecord>;
  gate?: StoryboardGateSetting;
};

export type MergeResult = { newConflicts: [] };
