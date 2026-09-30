/**
 * Phase 12 (`docs/roadmap/plans/PHASE_12_PLAN.md` §6, AC-P12-08) -- every CLI command, keyed
 * `"<namespace> <command>"`, classified for channel-bound agent sessions. The CLI refuses an
 * unclassified command in an agent session, and the inventory test fails the suite if this table
 * and the real command table (`parseArgs`) ever diverge. Same meaning as
 * `src/mcp/tool-classification.ts`.
 */
export type CliCommandClass = "bound" | "operator-only";

export const CLI_COMMAND_CLASSIFICATION: Readonly<Record<string, CliCommandClass>> = Object.freeze({
  // Default namespace (metadata).
  "metadata list": "bound",
  "metadata transcript": "bound",
  "metadata preview": "bound",
  "metadata apply": "bound",
  // Identity/session management -- operator-only, all of it (holes #1/#2).
  "auth login": "operator-only",
  "auth whoami": "operator-only",
  "auth list-channels": "operator-only",
  "auth select-channel": "operator-only",
  "auth list-users": "operator-only",
  "auth select-user": "operator-only",
  "auth logout": "operator-only",
  "auth revoke": "operator-only",
  "playlist list": "bound",
  "playlist create": "bound",
  "playlist update": "bound",
  "playlist delete": "bound",
  "playlist add": "bound",
  "playlist remove": "bound",
  "changeset list": "bound",
  "changeset get": "bound",
  "changeset preview": "bound",
  "changeset import": "bound",
  "batch list": "bound",
  "batch get": "bound",
  "channel sync": "bound",
  "channel list": "bound",
  "channel video-list": "bound",
  "analytics list": "bound",
  "analytics overview": "bound",
  "analytics data-quality": "bound",
  "analytics comparable-age": "bound",
  "analytics weekly-reports": "bound",
  "analytics weekly-report-get": "bound",
  "ai-localization generate": "bound",
  "ai-localization create-change-set": "bound",
  "agent capabilities": "bound",
  "agent channel-context": "bound",
  "agent video-context": "bound",
  "agent channel-analytics": "bound",
  "agent video-analytics": "bound",
  "agent list-assets": "bound",
  "agent get-asset-context": "bound",
  "agent get-generation-provenance": "bound",
  "agent create-content-proposal": "bound",
  "agent get-content-proposal": "bound",
  "agent list-content-proposals": "bound",
  "agent register-external-artifact": "bound",
  "agent list-proposal-artifacts": "bound",
  // Owner decision D2: channel folders only -- the global operations workspace is operator-only.
  "agent list-operations-files": "operator-only",
  "agent get-operations-file": "operator-only",
  "agent find-comparable-videos": "bound",
  "agent list-asset-performance": "bound",
  // Market data -- narrowed to records assigned to the agent's channel (owner decision D1, 12.4).
  "agent competitors": "bound",
  "agent market-intelligence": "bound",
  "agent market-records": "bound",
  "agent create-research-request": "bound",
  "agent list-hypotheses": "bound",
  "agent get-hypothesis-trail": "bound",
  "agent create-experiment-proposal": "bound",
  "agent channel-workspace": "bound",
  // Registers `local_path` references -- operator-only (owner spec §17's self-authorization concern).
  "asset register": "operator-only",
});
