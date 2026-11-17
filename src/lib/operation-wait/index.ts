// BL-271 (docs/roadmap/plans/WAIT_TOOLS_PLAN.md, ADR 0075): the wait core, its contracts and the process's stop signal. No database:
// the ports that read each target are composed in src/composition/wait-targets.ts.

export * from "./contracts";
export { createOperationWait, parseWaitInput, type OperationWait, type OperationWaitDependencies } from "./services";
export { shutdownSignal, signalShutdown } from "./shutdown";
