import { AGENT_TOKENS_REPORT_VERSION, agentTokensReportSchema, type AgentTokensReport } from "./contracts";
import { createPerDeviceReportCore, type PerDeviceReportStore } from "../per-device-report";

export type AgentTokensReportStore = PerDeviceReportStore;

export type AgentTokensShareDeps = {
  store: AgentTokensReportStore;
  ownDeviceId(): Promise<string>;
  clock?: { now(): Date };
};

/** BL-160: the agent tokens report -- the shared per-device report mechanics (`../per-device-report`) with this family's schema. */
export function createAgentTokensShareCore(deps: AgentTokensShareDeps) {
  return createPerDeviceReportCore<AgentTokensReport>({ schema: agentTokensReportSchema, label: "agent tokens report", currentVersion: AGENT_TOKENS_REPORT_VERSION, ...deps });
}

export type AgentTokensShareCore = ReturnType<typeof createAgentTokensShareCore>;
