import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

/**
 * Phase 7 slice I (owner spec §3/§30, `docs/AGENT_OPERATIONS_INTERFACE.md` §4i). This module
 * surfaces the CONTENTS of an operator-configured, out-of-repository folder holding Codex's own
 * operating/editorial instructions to the connected agent -- it never generates, templates, or
 * stores any such content itself (`AGENTS.md` §B: this repository never contains that content).
 * The configured path is set only through the operator-facing Settings API
 * (`src/app/api/settings/route.ts`), never through any `agent`-namespaced MCP tool or CLI command.
 */

export type OperationsWorkspaceFileEntry = {
  /** Forward-slash-normalized, relative to the configured base directory. Never absolute, never
   * exposes the configured base path itself (which would leak host filesystem layout/username). */
  path: string;
  isDirectory: boolean;
  /** `null` for a directory entry. */
  sizeBytes: number | null;
};

export type OperationsWorkspaceListResult =
  | { configured: false }
  | { configured: true; files: OperationsWorkspaceFileEntry[]; truncated: boolean };

export type OperationsWorkspaceFileResult =
  | { configured: false }
  | { configured: true; path: string; content: string; truncated: boolean };
