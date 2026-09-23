import { readFileSync } from "node:fs";
import path from "node:path";
import { SCHEMA_CURRENT_VERSION } from "@/lib/db";
import { createAgentOperationsServices } from "./services";

/**
 * Reads `package.json`'s own `version` field directly (the same field
 * `scripts/write-build-info.mjs` captures at build time into `public/build-info.json`) --
 * resolved via `process.cwd()`, the same repo-root-relative convention `src/lib/db.ts` already
 * uses for its own legacy-path lookup. Never throws: a missing/malformed `package.json` is not
 * something a capability-discovery call should fail over -- falls back to `"unknown"`, the same
 * "never fabricate a fact, but never crash over optional metadata" discipline this codebase
 * already applies elsewhere (e.g. `videos.viewCount`'s own null-not-zero convention).
 */
function readProductVersion(): string {
  try {
    const raw = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function createAgentOperationsCore() {
  return createAgentOperationsServices({
    getProductVersion: readProductVersion,
    getSchemaVersion: () => SCHEMA_CURRENT_VERSION,
  });
}

export type AgentOperationsCore = ReturnType<typeof createAgentOperationsCore>;
export {
  AGENT_API_VERSION,
  GRANTED_PERMISSIONS,
  PERMISSION_CLASSES,
  PLANNED_FUTURE_CAPABILITIES,
} from "./contracts";
export type {
  AgentCapabilityDescriptor,
  AgentCapabilityDomain,
  AgentDataDomain,
  PermissionClass,
  PlannedFutureCapability,
  SystemCapabilities,
} from "./contracts";
