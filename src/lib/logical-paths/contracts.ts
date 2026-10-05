import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/shared-domain";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError };

/**
 * Factory Operator access (`docs/roadmap/plans/FACTORY_OPERATOR_ACCESS_PLAN.md` §2.2) -- the registry
 * of logical paths: a stable name plus one local path string per device. This module's
 * responsibility ends at the path string: it never enumerates, reads, or writes anything INSIDE a
 * path. Values are set only through the operator-facing `/api/logical-paths` routes -- never
 * through any agent surface. Both tables are device-local: each machine configures only its own
 * values (owner decision, 2026-10-05).
 */

export const LOGICAL_PATH_AUDIENCES = ["all_agents", "factory_only"] as const;
export type LogicalPathAudience = (typeof LOGICAL_PATH_AUDIENCES)[number];

/**
 * Who is asking, for the agent-facing reads. `channel` = a channel-bound agent: sees only
 * `all_agents` paths. `factory` = the Factory Operator role: sees every path.
 */
export type LogicalPathReadScope = "channel" | "factory";

/** Operator Settings view: one entry per defined path, with THIS device's value and its status. */
export type LogicalPathOperatorEntry = {
  name: string;
  audience: LogicalPathAudience;
  description: string;
  /** This device's stored value, or `null` when none is set on this device. */
  path: string | null;
  /** `null` when no path is set; otherwise whether the directory exists on this device right now. */
  status: "exists" | "missing" | null;
  updatedAt: string | null;
};

/** Agent-facing listing entry. `configured:false` is the explicit "no value on this device" answer. */
export type LogicalPathReadEntry =
  | { name: string; description: string; configured: false }
  | { name: string; description: string; configured: true; path: string };
