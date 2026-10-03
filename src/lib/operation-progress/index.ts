import { recordActivity } from "@/lib/idle-shutdown";
import { createOperationRegistry, type OperationRegistry } from "./registry";

export type {
  OperationHandle,
  OperationItemSnapshot,
  OperationItemStatus,
  OperationRunStatus,
  OperationSnapshot,
  StartOperationInput,
} from "./contracts";
export { OperationAlreadyRunningError, isOperationAlreadyRunning } from "./contracts";
export { createOperationRegistry } from "./registry";
export type { OperationRegistry } from "./registry";

// One registry per server process. Kept on globalThis so Next's dev hot-reload (which re-evaluates
// modules) cannot orphan a running operation from the routes that poll it.
const REGISTRY_KEY = Symbol.for("youtube-operations-manager.operation-registry");

export function getOperationRegistry(): OperationRegistry {
  const holder = globalThis as unknown as Record<symbol, OperationRegistry | undefined>;
  return (holder[REGISTRY_KEY] ??= createOperationRegistry({ onHeartbeat: () => recordActivity() }));
}
