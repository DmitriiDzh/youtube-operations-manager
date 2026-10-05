import type { WorkspacePathValidationResult } from "@/lib/local-path-validation";
import { DomainError } from "./contracts";
import type {
  LogicalPathAudience,
  LogicalPathOperatorEntry,
  LogicalPathReadEntry,
  LogicalPathReadScope,
} from "./contracts";
import {
  createLogicalPathInputSchema,
  deleteLogicalPathInputSchema,
  getLogicalPathInputSchema,
  parseWithSchema,
  setLogicalPathValueInputSchema,
} from "./schemas";

export type LogicalPathStore = {
  listDefinitions(): Promise<Array<{ name: string; audience: string; description: string; createdAt: Date }>>;
  /** Returns `false` (nothing written) when the name already exists. */
  insertDefinition(input: { name: string; audience: LogicalPathAudience; description: string }): Promise<boolean>;
  /** Removes the definition and every stored value for the name; `false` if it did not exist. */
  deleteDefinition(name: string): Promise<boolean>;
  getValue(deviceId: string, name: string): Promise<string | null>;
  listValues(deviceId: string): Promise<Array<{ name: string; path: string; updatedAt: Date }>>;
  /** `null` deletes this device's value. */
  setValue(deviceId: string, name: string, path: string | null): Promise<void>;
};

export type ServiceDependencies = {
  /** This installation's bootstrap `deviceId`, or `null` if none exists yet. Used by every READ: a
   * read must never create the device identity as a side effect. No deviceId means no value can
   * exist for this device yet, so reads answer "not configured". */
  readDeviceId(): Promise<string | null>;
  /** Same `deviceId`, created on first use -- used ONLY by the operator-facing write. */
  ensureDeviceId(): Promise<string>;
  store: LogicalPathStore;
  /** Set-time only (`src/lib/local-path-validation`). Never used by an agent-facing read. */
  validatePath(candidatePath: string): Promise<WorkspacePathValidationResult>;
  /** Operator listing only: whether the directory currently exists on this device. */
  pathExists(path: string): Promise<boolean>;
};

function notFound(name: string): DomainError {
  return new DomainError({
    code: "LOGICAL_PATH_NOT_FOUND",
    message: "no logical path with this name is available",
    details: { name },
  });
}

/** An agent scope may see only these audiences; `factory` sees every path. */
function isVisible(scope: LogicalPathReadScope, audience: string): boolean {
  return scope === "factory" || audience === "all_agents";
}

export function createLogicalPathServices(deps: ServiceDependencies) {
  async function requireDefinition(name: string) {
    const definition = (await deps.store.listDefinitions()).find((entry) => entry.name === name);
    if (!definition) throw notFound(name);
    return definition;
  }

  return {
    /**
     * Agent-facing read of one path for THIS device. A store lookup that never touches anything at
     * or under the path. An unknown name and a name the scope may not see fail identically
     * (`LOGICAL_PATH_NOT_FOUND`); a defined path with no value on this device fails with the explicit
     * `LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE` -- never an empty-string path.
     */
    async readPath(input: unknown, scope: LogicalPathReadScope): Promise<{ name: string; path: string }> {
      const { name } = parseWithSchema(getLogicalPathInputSchema, input, "get logical path input");
      const definition = (await deps.store.listDefinitions()).find((entry) => entry.name === name);
      if (!definition || !isVisible(scope, definition.audience)) throw notFound(name);
      const deviceId = await deps.readDeviceId();
      const path = deviceId ? await deps.store.getValue(deviceId, name) : null;
      if (!path) {
        throw new DomainError({
          code: "LOGICAL_PATH_NOT_CONFIGURED_ON_DEVICE",
          message: "this logical path has no value on this device",
          details: { name },
        });
      }
      return { name, path };
    },

    /** Agent-facing listing for THIS device, limited to the scope's visible audiences. */
    async listReadable(scope: LogicalPathReadScope): Promise<LogicalPathReadEntry[]> {
      const deviceId = await deps.readDeviceId();
      const [definitions, values] = await Promise.all([
        deps.store.listDefinitions(),
        deviceId ? deps.store.listValues(deviceId) : Promise.resolve([]),
      ]);
      const byName = new Map(values.map((row) => [row.name, row.path]));
      return definitions
        .filter((definition) => isVisible(scope, definition.audience))
        .map((definition): LogicalPathReadEntry => {
          const path = byName.get(definition.name);
          return path
            ? { name: definition.name, description: definition.description, configured: true, path }
            : { name: definition.name, description: definition.description, configured: false };
        });
    },

    /** Operator Settings view: every defined path with this device's value and whether it exists. */
    async listForOperator(): Promise<LogicalPathOperatorEntry[]> {
      const deviceId = await deps.readDeviceId();
      const [definitions, values] = await Promise.all([
        deps.store.listDefinitions(),
        deviceId ? deps.store.listValues(deviceId) : Promise.resolve([]),
      ]);
      const byName = new Map(values.map((row) => [row.name, row]));
      return Promise.all(
        definitions.map(async (definition): Promise<LogicalPathOperatorEntry> => {
          const row = byName.get(definition.name);
          return {
            name: definition.name,
            audience: definition.audience as LogicalPathAudience,
            description: definition.description,
            path: row?.path ?? null,
            status: row ? ((await deps.pathExists(row.path)) ? "exists" : "missing") : null,
            updatedAt: row ? row.updatedAt.toISOString() : null,
          };
        })
      );
    },

    /** Operator-only. A name that already exists is rejected; nothing is overwritten. */
    async createPath(input: unknown): Promise<{ name: string }> {
      const parsed = parseWithSchema(createLogicalPathInputSchema, input, "create logical path input");
      const created = await deps.store.insertDefinition({
        name: parsed.name,
        audience: parsed.audience,
        description: parsed.description.trim(),
      });
      if (!created) {
        throw new DomainError({
          code: "LOGICAL_PATH_ALREADY_EXISTS",
          message: "a logical path with this name already exists",
          details: { name: parsed.name },
        });
      }
      return { name: parsed.name };
    },

    /** Operator-only. Removes the definition and every stored value of that name. */
    async deletePath(input: unknown): Promise<{ name: string }> {
      const { name } = parseWithSchema(deleteLogicalPathInputSchema, input, "delete logical path input");
      if (!(await deps.store.deleteDefinition(name))) throw notFound(name);
      return { name };
    },

    /**
     * Operator-only write of THIS device's value -- never reachable from an agent surface.
     * Validates the path once, at set time (absolute, exists, is a directory, does not overlap the
     * app-data directory). Nothing is stored when validation fails. `null`/blank clears.
     */
    async setValue(input: unknown): Promise<{ name: string; path: string | null }> {
      const parsed = parseWithSchema(setLogicalPathValueInputSchema, input, "set logical path value input");
      await requireDefinition(parsed.name);
      const deviceId = await deps.ensureDeviceId();

      const candidate = parsed.path?.trim() ?? "";
      if (candidate === "") {
        await deps.store.setValue(deviceId, parsed.name, null);
        return { name: parsed.name, path: null };
      }

      const validation = await deps.validatePath(candidate);
      if (!validation.ok) {
        throw new DomainError({
          code: "LOGICAL_PATH_VALUE_INVALID",
          message: `logical path value rejected: ${validation.reason}`,
          details: { name: parsed.name, reason: validation.reason },
        });
      }
      await deps.store.setValue(deviceId, parsed.name, candidate);
      return { name: parsed.name, path: candidate };
    },
  };
}

export type LogicalPathServices = ReturnType<typeof createLogicalPathServices>;
