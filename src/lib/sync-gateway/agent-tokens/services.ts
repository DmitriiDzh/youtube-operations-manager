import { AGENT_TOKENS_REPORT_VERSION, agentTokensReportSchema, type AgentTokensReport } from "./contracts";
import { createPerDeviceReportCore, type PerDeviceReportStore } from "../per-device-report";

export type AgentTokensReportStore = PerDeviceReportStore;

export type AgentTokensShareDeps = {
  store: AgentTokensReportStore;
  ownDeviceId(): Promise<string>;
  clock?: { now(): Date };
};

/**
 * BL-160: the agent tokens report -- the shared per-device report mechanics (`../per-device-report`) with this family's schema. A
 * peer's report is never forgotten: it stays true while its device is quiet, and a revocation in it must still reach a device that
 * comes back after weeks (independent review, BL-160 round 1).
 */
export function createAgentTokensShareCore(deps: AgentTokensShareDeps) {
  return createPerDeviceReportCore<AgentTokensReport>({
    schema: agentTokensReportSchema,
    label: "agent tokens report",
    currentVersion: AGENT_TOKENS_REPORT_VERSION,
    ...deps,
    forgetAfterMs: null,
  });
}

export type AgentTokensShareCore = ReturnType<typeof createAgentTokensShareCore>;
