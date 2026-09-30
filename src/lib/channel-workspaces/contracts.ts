import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError };

/**
 * Phase 11 -- Channel Workspaces (`docs/roadmap/FUTURE_PHASES.md` §11,
 * `docs/roadmap/plans/PHASE_11_PLAN.md`). One operator-set local production-workspace path per
 * linked channel, per device. This module's responsibility ends at the path string: it never
 * enumerates, reads, writes, or validates anything INSIDE the path (only the path itself, once,
 * at set time). The path is set only through the operator-facing `/api/channel-workspaces`
 * route -- never through any agent-callable MCP tool or CLI command.
 */

/** `configured: false` is the explicit "never set" answer -- never an empty-string path. */
export type ChannelWorkspaceResult = { configured: false } | { configured: true; path: string };

export type ChannelWorkspaceListEntry = {
  channelId: string;
  path: string | null;
  updatedAt: string | null;
};
