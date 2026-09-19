import type { StoredAiConnection, StoredAiConnectionCredential } from "@/lib/db";
import {
  DomainError,
  isDomainError,
  type AdapterType,
  type AiConnection,
  type ConnectionProtocolAdapter,
  type CreateConnectionInput,
  type LocalizationProvider,
  type PricingMetadata,
  type UpdateConnectionInput,
} from "./contracts";
import { decryptSecret, encryptSecret, requireEncryptionKey, type ResolveEncryptionKey } from "./crypto";
import {
  createConnectionInputSchema,
  deleteConnectionInputSchema,
  getConnectionInputSchema,
  parseWithSchema,
  testConnectionInputSchema,
  updateConnectionInputSchema,
} from "./schemas";

type ServiceDependencies = {
  connectionStore: {
    createConnection(input: {
      id: string;
      displayName: string;
      adapterType: AdapterType;
      baseUrl: string | null;
      modelId: string;
      localInferenceMode: boolean;
      enabled: boolean;
      capabilitiesJson: string;
      assignedTasksJson: string;
      pricingJson: string | null;
    }): Promise<StoredAiConnection>;
    listConnections(): Promise<StoredAiConnection[]>;
    getConnection(connectionId: string): Promise<StoredAiConnection | null>;
    updateConnection(
      connectionId: string,
      patch: Partial<{
        displayName: string;
        baseUrl: string | null;
        modelId: string;
        localInferenceMode: boolean;
        enabled: boolean;
        status: string;
        statusMessage: string | null;
        statusCheckedAt: Date | null;
        capabilitiesJson: string;
        assignedTasksJson: string;
        pricingJson: string | null;
      }>
    ): Promise<StoredAiConnection | null>;
    deleteConnection(connectionId: string): Promise<void>;
  };
  credentialStore: {
    upsertCredential(input: StoredAiConnectionCredential): Promise<void>;
    getCredential(connectionId: string): Promise<StoredAiConnectionCredential | null>;
    deleteCredential(connectionId: string): Promise<void>;
  };
  resolveEncryptionKey: ResolveEncryptionKey;
  protocolAdapters: Record<AdapterType, ConnectionProtocolAdapter>;
  idGenerator: () => string;
  logger: {
    info(payload: { event: string; context?: Record<string, unknown> }): void;
    error(payload: { event: string; context?: Record<string, unknown> }): void;
  };
};

function mapUnknownError(error: unknown, fallbackCode: DomainError["code"]) {
  if (isDomainError(error)) return error;
  return new DomainError({ code: fallbackCode, message: error instanceof Error ? error.message : "Unknown error" });
}

function toPublicConnection(stored: StoredAiConnection, hasCredential: boolean): AiConnection {
  return {
    id: stored.id,
    displayName: stored.displayName,
    adapterType: stored.adapterType as AdapterType,
    baseUrl: stored.baseUrl,
    modelId: stored.modelId,
    localInferenceMode: stored.localInferenceMode,
    enabled: stored.enabled,
    status: stored.status as AiConnection["status"],
    statusMessage: stored.statusMessage,
    statusCheckedAt: stored.statusCheckedAt ? stored.statusCheckedAt.toISOString() : null,
    capabilities: JSON.parse(stored.capabilitiesJson),
    assignedTasks: JSON.parse(stored.assignedTasksJson),
    pricing: stored.pricingJson ? (JSON.parse(stored.pricingJson) as PricingMetadata) : null,
    hasCredential,
    createdAt: stored.createdAt.toISOString(),
    updatedAt: stored.updatedAt.toISOString(),
  };
}

async function requireConnection(deps: ServiceDependencies, connectionId: string): Promise<StoredAiConnection> {
  const connection = await deps.connectionStore.getConnection(connectionId);
  if (!connection) {
    throw new DomainError({ code: "not_found", message: "Connection not found", details: { connectionId } });
  }
  return connection;
}

function resolveAdapter(deps: ServiceDependencies, adapterType: AdapterType): ConnectionProtocolAdapter {
  const adapter = deps.protocolAdapters[adapterType];
  if (!adapter) {
    throw new DomainError({ code: "provider_not_configured", message: `No protocol adapter registered for "${adapterType}"` });
  }
  return adapter;
}

export function createAiConnectionServices(deps: ServiceDependencies) {
  return {
    async createConnection(input: unknown): Promise<AiConnection> {
      const parsedInput = parseWithSchema(createConnectionInputSchema, input, "create connection input") as CreateConnectionInput;

      try {
        // Resolve the encryption key BEFORE creating the connection row: if a
        // credential was submitted but no key is configured, this must fail with
        // nothing persisted at all -- never an orphaned connection row with a
        // credential that silently never got saved (AC-CONN-03).
        const encrypted = parsedInput.apiKey ? encryptSecret(parsedInput.apiKey, requireEncryptionKey(deps.resolveEncryptionKey)) : null;

        const id = deps.idGenerator();
        const stored = await deps.connectionStore.createConnection({
          id,
          displayName: parsedInput.displayName,
          adapterType: parsedInput.adapterType,
          baseUrl: parsedInput.baseUrl ?? null,
          modelId: parsedInput.modelId,
          localInferenceMode: parsedInput.localInferenceMode ?? false,
          enabled: parsedInput.enabled ?? true,
          capabilitiesJson: JSON.stringify(parsedInput.capabilities),
          assignedTasksJson: JSON.stringify(parsedInput.assignedTasks ?? ["ai_localization"]),
          pricingJson: parsedInput.pricing !== undefined && parsedInput.pricing !== null ? JSON.stringify(parsedInput.pricing) : null,
        });

        let hasCredential = false;
        if (encrypted) {
          await deps.credentialStore.upsertCredential({ connectionId: id, ...encrypted });
          hasCredential = true;
        }

        deps.logger.info({ event: "ai_connections.create.success", context: { connectionId: id, adapterType: parsedInput.adapterType } });
        return toPublicConnection(stored, hasCredential);
      } catch (error) {
        const mapped = mapUnknownError(error, "validation_failed");
        deps.logger.error({ event: "ai_connections.create.error", context: { code: mapped.code } });
        throw mapped;
      }
    },

    async listConnections(): Promise<AiConnection[]> {
      const stored = await deps.connectionStore.listConnections();
      const result: AiConnection[] = [];
      for (const s of stored) {
        const credential = await deps.credentialStore.getCredential(s.id);
        result.push(toPublicConnection(s, credential !== null));
      }
      return result;
    },

    async getConnection(input: unknown): Promise<AiConnection> {
      const parsedInput = parseWithSchema(getConnectionInputSchema, input, "get connection input");
      const stored = await requireConnection(deps, parsedInput.connectionId);
      const credential = await deps.credentialStore.getCredential(stored.id);
      return toPublicConnection(stored, credential !== null);
    },

    async updateConnection(input: unknown): Promise<AiConnection> {
      const parsedInput = parseWithSchema(updateConnectionInputSchema, input, "update connection input") as UpdateConnectionInput;

      try {
        const existing = await requireConnection(deps, parsedInput.connectionId);

        // Same ordering rule as createConnection: resolve the encryption
        // requirement BEFORE writing anything, so a missing key fails the whole
        // update atomically rather than applying other field changes first.
        const encryptedReplacement =
          typeof parsedInput.apiKey === "string" ? encryptSecret(parsedInput.apiKey, requireEncryptionKey(deps.resolveEncryptionKey)) : null;

        const patch: Record<string, unknown> = {};
        if (parsedInput.displayName !== undefined) patch.displayName = parsedInput.displayName;
        if (parsedInput.baseUrl !== undefined) patch.baseUrl = parsedInput.baseUrl;
        if (parsedInput.modelId !== undefined) patch.modelId = parsedInput.modelId;
        if (parsedInput.localInferenceMode !== undefined) patch.localInferenceMode = parsedInput.localInferenceMode;
        if (parsedInput.enabled !== undefined) patch.enabled = parsedInput.enabled;
        if (parsedInput.capabilities !== undefined) patch.capabilitiesJson = JSON.stringify(parsedInput.capabilities);
        if (parsedInput.assignedTasks !== undefined) patch.assignedTasksJson = JSON.stringify(parsedInput.assignedTasks);
        if (parsedInput.pricing !== undefined) patch.pricingJson = parsedInput.pricing === null ? null : JSON.stringify(parsedInput.pricing);

        const stored = Object.keys(patch).length > 0 ? await deps.connectionStore.updateConnection(existing.id, patch) : existing;
        if (!stored) {
          throw new DomainError({ code: "not_found", message: "Connection disappeared during update", details: { connectionId: existing.id } });
        }

        let hasCredential: boolean;
        if (parsedInput.apiKey === undefined) {
          hasCredential = (await deps.credentialStore.getCredential(existing.id)) !== null;
        } else if (parsedInput.apiKey === null) {
          await deps.credentialStore.deleteCredential(existing.id);
          hasCredential = false;
        } else {
          await deps.credentialStore.upsertCredential({ connectionId: existing.id, ...encryptedReplacement! });
          hasCredential = true;
        }

        deps.logger.info({ event: "ai_connections.update.success", context: { connectionId: existing.id } });
        return toPublicConnection(stored, hasCredential);
      } catch (error) {
        const mapped = mapUnknownError(error, "validation_failed");
        deps.logger.error({ event: "ai_connections.update.error", context: { code: mapped.code } });
        throw mapped;
      }
    },

    async deleteConnection(input: unknown): Promise<void> {
      const parsedInput = parseWithSchema(deleteConnectionInputSchema, input, "delete connection input");
      await requireConnection(deps, parsedInput.connectionId);
      await deps.connectionStore.deleteConnection(parsedInput.connectionId);
      deps.logger.info({ event: "ai_connections.delete.success", context: { connectionId: parsedInput.connectionId } });
    },

    /** Explicit, user-triggered only (INV-AIC-2/AC-CONN-15) -- never called from
     * generation or from module load. */
    async testConnection(input: unknown): Promise<{ ok: boolean; message: string; mayIncurCost: boolean }> {
      const parsedInput = parseWithSchema(testConnectionInputSchema, input, "test connection input");

      try {
        const stored = await requireConnection(deps, parsedInput.connectionId);
        const connection = toPublicConnection(stored, false);
        const adapter = resolveAdapter(deps, connection.adapterType);
        const credentialRecord = await deps.credentialStore.getCredential(stored.id);
        const credential = credentialRecord ? decryptSecret(credentialRecord, requireEncryptionKey(deps.resolveEncryptionKey)) : null;

        const result = await adapter.testConnection({ connection, credential });

        await deps.connectionStore.updateConnection(stored.id, {
          status: result.ok ? "ok" : "error",
          statusMessage: result.message,
          statusCheckedAt: new Date(),
        });

        return result;
      } catch (error) {
        const mapped = mapUnknownError(error, "validation_failed");
        deps.logger.error({ event: "ai_connections.test.error", context: { code: mapped.code } });
        throw mapped;
      }
    },

    /**
     * Bridges a chosen, enabled connection into the exact `LocalizationProvider`
     * shape src/lib/ai-localization/services.ts already depends on, so that domain
     * never needs to know connections, adapters, or credentials exist. Resolves the
     * connection and decrypts its credential ONCE per call (not once per target),
     * mirroring how `resolveProvider(providerName)` is already called once before
     * the per-target loop in `generateProposals`.
     */
    async resolveConnectionProvider(connectionId: string): Promise<LocalizationProvider> {
      const stored = await requireConnection(deps, connectionId);
      if (!stored.enabled) {
        throw new DomainError({ code: "connection_disabled", message: "This connection is disabled", details: { connectionId } });
      }
      const connection = toPublicConnection(stored, false);
      const adapter = resolveAdapter(deps, connection.adapterType);
      const credentialRecord = await deps.credentialStore.getCredential(stored.id);
      const credential = credentialRecord ? decryptSecret(credentialRecord, requireEncryptionKey(deps.resolveEncryptionKey)) : null;

      return {
        name: connection.displayName,
        async generate(request) {
          const { outcome, usage } = await adapter.generate({ connection, credential, request });
          if (outcome.status === "ok" && usage) {
            return { ...outcome, usage };
          }
          return outcome;
        },
      };
    },
  };
}

export type AiConnectionServices = ReturnType<typeof createAiConnectionServices>;
