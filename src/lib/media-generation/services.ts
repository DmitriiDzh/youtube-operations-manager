import { decryptSecret, encryptSecret, type EncryptedPayload } from "@/lib/shared-crypto";
import type { CreatePodInput, RunpodApiClient, RunpodDataCenter, RunpodGpuType, RunpodNetworkVolume, RunpodPod, RunpodS3Client, RunpodS3Config } from "@/lib/media-gateway";
import { comfyUiProxyBaseUrl } from "@/lib/media-gateway";
import {
  COMFY_PROXY_PORT,
  DEFAULT_MEDIA_SETTINGS,
  DomainError,
  RUNPOD_KEY_PREFIX_LENGTH,
  type MediaCredentialsStatus,
  type MediaCredentialsTestResult,
  type MediaGenerationOverview,
  type MediaSettings,
} from "./contracts";
import type { KeyFile } from "./key-file";
import {
  createNetworkVolumeInputSchema,
  createPodPassthroughSchema,
  createTemplatePassthroughSchema,
  mediaSettingsSchema,
  parseWithSchema,
  setCredentialsInputSchema,
  updateSettingsInputSchema,
} from "./schemas";

export type StoredCredentialsRow = {
  ciphertext: string;
  iv: string;
  authTag: string;
  runpodKeyPrefix: string;
  s3AccessKeyId: string | null;
  verifiedAt: Date | null;
  updatedAt: Date;
};

export type MediaGenerationStore = {
  getCredentials(): Promise<StoredCredentialsRow | null>;
  upsertCredentials(input: { ciphertext: string; iv: string; authTag: string; runpodKeyPrefix: string; s3AccessKeyId: string | null }): Promise<void>;
  setCredentialsVerifiedAt(at: Date): Promise<void>;
  clearCredentials(): Promise<void>;
  getSettingsJson(): Promise<string | null>;
  setSettingsJson(json: string): Promise<void>;
  getGatewayEnabled(): Promise<boolean>;
  setGatewayEnabled(enabled: boolean): Promise<void>;
};

/** The decrypted blob -- lives only inside this module, for the duration of one call. */
type SecretSet = { runpodApiKey: string; s3AccessKeyId: string | null; s3SecretAccessKey: string | null };

export type ServiceDependencies = {
  store: MediaGenerationStore;
  keyFile: KeyFile;
  /** Gateway factories (`src/lib/media-gateway/`), injected so tests never touch the network. */
  gateway: {
    createRunpodClient(apiKey: string): RunpodApiClient;
    createS3Client(config: RunpodS3Config): RunpodS3Client;
  };
  clock: { now(): Date };
  /** Who holds the volume lock right now (a session or pull still active), or null -- late-bound by the core. */
  activeVolumeHolder?: () => Promise<string | null>;
  log?: (line: string) => void;
};

/** The URL this app (and the scripts) use for ComfyUI on a pod -- built here so no caller spells the proxy host itself. */
function withProxyUrl(pod: RunpodPod): RunpodPod & { comfyUiProxyUrl: string } {
  let comfyUiProxyUrl = "";
  try {
    comfyUiProxyUrl = comfyUiProxyBaseUrl(pod.id, COMFY_PROXY_PORT);
  } catch {
    // an id that does not look like a pod id (never from RunPod itself) gets no URL rather than an error
  }
  return { ...pod, comfyUiProxyUrl };
}

export function createMediaGenerationServices(deps: ServiceDependencies) {
  async function readSettings(): Promise<MediaSettings> {
    const json = await deps.store.getSettingsJson();
    if (!json) return { ...DEFAULT_MEDIA_SETTINGS };
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return { ...DEFAULT_MEDIA_SETTINGS };
    }
    const stored = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const result = mediaSettingsSchema.safeParse({ ...DEFAULT_MEDIA_SETTINGS, ...stored });
    if (result.success) return result.data;
    // Never reset EVERYTHING (the spend cap included) because one key is off (a key from a newer build, a value a
    // tightened schema no longer accepts): keep every key that validates on its own, default only the offending ones,
    // and say so (review round 9).
    const salvaged: Record<string, unknown> = { ...DEFAULT_MEDIA_SETTINGS };
    const dropped: string[] = [];
    for (const [key, fieldSchema] of Object.entries(mediaSettingsSchema.shape)) {
      if (!(key in stored)) continue;
      const field = (fieldSchema as { safeParse(v: unknown): { success: boolean; data?: unknown } }).safeParse(stored[key]);
      if (field.success) salvaged[key] = field.data;
      else dropped.push(key);
    }
    for (const key of Object.keys(stored)) if (!(key in mediaSettingsSchema.shape)) dropped.push(key);
    (deps.log ?? (() => undefined))(`[media] stored settings partly invalid; kept the valid keys, defaulted: ${dropped.join(", ") || "(none)"}`);
    const salvagedResult = mediaSettingsSchema.safeParse(salvaged);
    return salvagedResult.success ? salvagedResult.data : { ...DEFAULT_MEDIA_SETTINGS };
  }

  async function credentialsStatus(): Promise<MediaCredentialsStatus> {
    const row = await deps.store.getCredentials();
    if (!row) return { configured: false, reason: "no_credentials" };
    // AC-P14-21: a row with no key file on this device is "not configured" -- no decryption attempt.
    if ((await deps.keyFile.readKey()) === null) return { configured: false, reason: "key_file_missing" };
    return {
      configured: true,
      runpodKeyPrefix: row.runpodKeyPrefix,
      s3AccessKeyId: row.s3AccessKeyId,
      verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Decrypts for one call. Never returned by any public method. */
  async function requireSecrets(): Promise<SecretSet> {
    const row = await deps.store.getCredentials();
    const key = row ? await deps.keyFile.readKey() : null;
    if (!row || !key) {
      throw new DomainError({
        code: "media_generation_not_configured",
        message: !row
          ? "No RunPod credentials are configured on this device (Settings → Media → Credentials)."
          : "The stored RunPod credentials cannot be read on this device: the key file is missing. Enter the credentials again.",
      });
    }
    const payload: EncryptedPayload = { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag };
    let plaintext: string;
    try {
      plaintext = decryptSecret(payload, key);
    } catch {
      throw new DomainError({
        code: "media_generation_not_configured",
        message: "The stored RunPod credentials do not match this device's key file. Clear them and enter them again.",
      });
    }
    return JSON.parse(plaintext) as SecretSet;
  }

  async function runpodClient(): Promise<RunpodApiClient> {
    const secrets = await requireSecrets();
    return deps.gateway.createRunpodClient(secrets.runpodApiKey);
  }

  async function s3ClientIfConfigured(): Promise<{ client: RunpodS3Client } | { skipped: string }> {
    const secrets = await requireSecrets();
    const settings = await readSettings();
    if (!secrets.s3AccessKeyId || !secrets.s3SecretAccessKey) return { skipped: "no S3 key pair is stored" };
    if (!settings.datacenterId || !settings.networkVolumeId) return { skipped: "datacenter or network volume is not set yet" };
    return {
      client: deps.gateway.createS3Client({
        datacenterId: settings.datacenterId,
        volumeId: settings.networkVolumeId,
        accessKeyId: secrets.s3AccessKeyId,
        secretAccessKey: secrets.s3SecretAccessKey,
      }),
    };
  }

  return {
    async getOverview(): Promise<MediaGenerationOverview> {
      const [credentials, settings, gatewayEnabled] = await Promise.all([credentialsStatus(), readSettings(), deps.store.getGatewayEnabled()]);
      const missing: string[] = [];
      if (!credentials.configured) missing.push("RunPod credentials");
      if (!settings.datacenterId) missing.push("datacenter");
      if (!settings.gpuTypeId) missing.push("GPU type");
      if (!settings.networkVolumeId) missing.push("network volume");
      if (!settings.templateId) missing.push("pod template");
      if (!gatewayEnabled) missing.push("media gateway toggle (off)");
      return { credentials, settings, gatewayEnabled, ready: missing.length === 0, missing };
    },

    getCredentialsStatus: credentialsStatus,

    /**
     * Operator-only. Encrypts the whole set under the device key (created on first use) and
     * resets `verifiedAt`. Returns the public status only (AC-P14-02/21).
     */
    async setCredentials(input: unknown): Promise<MediaCredentialsStatus> {
      const parsed = parseWithSchema(setCredentialsInputSchema, input, "media credentials");
      const key = await deps.keyFile.readOrCreateKey();
      const secrets: SecretSet = {
        runpodApiKey: parsed.runpodApiKey,
        s3AccessKeyId: parsed.s3AccessKeyId ?? null,
        s3SecretAccessKey: parsed.s3SecretAccessKey ?? null,
      };
      const encrypted = encryptSecret(JSON.stringify(secrets), key);
      await deps.store.upsertCredentials({
        ...encrypted,
        runpodKeyPrefix: `${parsed.runpodApiKey.slice(0, RUNPOD_KEY_PREFIX_LENGTH)}…`,
        s3AccessKeyId: secrets.s3AccessKeyId,
      });
      return credentialsStatus();
    },

    async clearCredentials(): Promise<MediaCredentialsStatus> {
      await deps.store.clearCredentials();
      return credentialsStatus();
    },

    /** One read call per service; a success stamps `verifiedAt`. Never throws for a failed probe -- reports it. */
    async testCredentials(): Promise<MediaCredentialsTestResult> {
      const client = await runpodClient();
      let runpod: MediaCredentialsTestResult["runpod"];
      try {
        await client.verifyKey();
        runpod = { ok: true };
      } catch (error) {
        runpod = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      let s3: MediaCredentialsTestResult["s3"];
      const s3Client = await s3ClientIfConfigured();
      if ("skipped" in s3Client) {
        s3 = { skipped: true, reason: s3Client.skipped };
      } else {
        try {
          await s3Client.client.testAccess();
          s3 = { ok: true };
        } catch (error) {
          s3 = { ok: false, message: error instanceof Error ? error.message : String(error) };
        }
      }
      let verifiedAt: string | null = null;
      if (runpod.ok && !("ok" in s3 && !s3.ok)) {
        const now = deps.clock.now();
        await deps.store.setCredentialsVerifiedAt(now);
        verifiedAt = now.toISOString();
      }
      return { runpod, s3, verifiedAt };
    },

    getSettings: readSettings,

    /**
     * Merges a partial update into the stored settings. Live-catalog checks (AC-P14-19): a GPU id
     * must be in RunPod's catalog, a network volume must exist and sit in the chosen datacenter --
     * both need credentials, so setting them before credentials is refused.
     */
    async updateSettings(input: unknown): Promise<MediaSettings> {
      const update = parseWithSchema(updateSettingsInputSchema, input, "media settings");
      const current = await readSettings();
      const next = parseWithSchema(mediaSettingsSchema, { ...current, ...update }, "media settings");
      if (update.gpuTypeId === null) next.gpuOnDemandPricePerHr = null;

      // A cloud-type change re-prices the already-chosen GPU (SECURE and COMMUNITY differ), so it touches the catalog too.
      // A changed cloud type OR datacenter re-validates and re-prices the kept GPU against the live catalog (AC-P14-19):
      // the GPU may not exist there, or cost something else (review round 10).
      const repriceGpu =
        ((update.cloudType !== undefined && update.cloudType !== current.cloudType) || (update.datacenterId !== undefined && update.datacenterId !== current.datacenterId)) &&
        next.gpuTypeId !== null &&
        update.gpuTypeId === undefined;
      if (repriceGpu) update.gpuTypeId = next.gpuTypeId;
      const needsCatalog = (update.gpuTypeId !== undefined && update.gpuTypeId !== null) || (update.networkVolumeId !== undefined && update.networkVolumeId !== null) || (update.datacenterId !== undefined && update.datacenterId !== null);
      if (needsCatalog) {
        const client = await runpodClient();
        if (next.datacenterId && update.datacenterId !== undefined) {
          const datacenters = await client.listDataCenters();
          if (!datacenters.some((dc) => dc.id === next.datacenterId)) {
            throw new DomainError({ code: "media_settings_invalid", message: `Datacenter ${next.datacenterId} is not in RunPod's catalog.`, details: { field: "datacenterId" } });
          }
        }
        if (next.gpuTypeId && update.gpuTypeId !== undefined) {
          const gpus = await client.listGpuTypes({ cloud: next.cloudType });
          const gpu = gpus.find((g) => g.id === next.gpuTypeId);
          if (!gpu) {
            throw new DomainError({ code: "media_settings_invalid", message: `GPU type "${next.gpuTypeId}" is not in RunPod's catalog.`, details: { field: "gpuTypeId" } });
          }
          // The catalog lists where each GPU is offered: a GPU/datacenter pair RunPod does not offer is refused here, not
          // at approve time by a failed createPod (review round 11). An empty list means the API did not say -- allowed.
          if (next.datacenterId && gpu.dataCenters.length > 0 && !gpu.dataCenters.some((dc) => dc.id === next.datacenterId)) {
            throw new DomainError({
              code: "media_settings_invalid",
              message: `GPU type "${next.gpuTypeId}" is not offered in datacenter ${next.datacenterId} (offered in: ${gpu.dataCenters.map((dc) => dc.id).join(", ")}).`,
              details: { field: "gpuTypeId", datacenterId: next.datacenterId, offeredIn: gpu.dataCenters.map((dc) => dc.id) },
            });
          }
          // Captured here so a session estimate needs no RunPod call (AC-P14-03).
          next.gpuOnDemandPricePerHr = gpu.onDemandPricePerHr;
        }
        if (next.networkVolumeId && (update.networkVolumeId !== undefined || update.datacenterId !== undefined)) {
          const volume = await client.getNetworkVolume(next.networkVolumeId);
          if (!volume) {
            throw new DomainError({ code: "media_settings_invalid", message: `Network volume ${next.networkVolumeId} does not exist.`, details: { field: "networkVolumeId" } });
          }
          if (next.datacenterId && volume.dataCenterId !== next.datacenterId) {
            throw new DomainError({
              code: "media_settings_invalid",
              message: `Network volume ${next.networkVolumeId} is in ${volume.dataCenterId}, not in the chosen datacenter ${next.datacenterId}.`,
              details: { field: "networkVolumeId", volumeDatacenterId: volume.dataCenterId },
            });
          }
        }
      }
      await deps.store.setSettingsJson(JSON.stringify(next));
      return next;
    },

    getGatewayEnabled: () => deps.store.getGatewayEnabled(),
    /**
     * Disabling the gateway while a pod is open or a pull is running would disable the only path that can terminate
     * that pod (watcher, Stop, shutdown, boot sweep all go through the gated client) -- the caps would stop being
     * enforced and the pod would bill until the toggle came back. Refused while the volume lock has an active holder.
     */
    async setGatewayEnabled(enabled: boolean): Promise<void> {
      if (!enabled && deps.activeVolumeHolder) {
        const holder = await deps.activeVolumeHolder();
        if (holder) {
          throw new DomainError({
            code: "media_session_conflict",
            message: `The media gateway cannot be disabled while ${holder.startsWith("pull:") ? "a model pull is running" : "a generation session is open"} (${holder}): the pod could then never be terminated. Stop it first.`,
            details: { holder },
          });
        }
      }
      await deps.store.setGatewayEnabled(enabled);
    },

    // -- used by the session services (same device key as the credentials; the key never leaves) --

    /** Encrypts a per-session secret (the ComfyUI proxy token) under the device key. */
    async sealSecret(plaintext: string): Promise<EncryptedPayload> {
      const key = await deps.keyFile.readKey();
      if (!key) throw new DomainError({ code: "media_generation_not_configured", message: "No device key file yet -- save the RunPod credentials first." });
      return encryptSecret(plaintext, key);
    },

    async openSecret(payload: EncryptedPayload): Promise<string> {
      const key = await deps.keyFile.readKey();
      if (!key) throw new DomainError({ code: "media_generation_not_configured", message: "The device key file is missing." });
      return decryptSecret(payload, key);
    },

    /** The RunPod client for one call sequence; the key stays inside its closure. */
    resolveRunpodClient: runpodClient,

    // -- RunPod reads (each needs credentials; nothing cached, nothing persisted) --------------

    async listGpuTypes(): Promise<RunpodGpuType[]> {
      const settings = await readSettings();
      return (await runpodClient()).listGpuTypes({ cloud: settings.cloudType });
    },

    async listDataCenters(): Promise<RunpodDataCenter[]> {
      return (await runpodClient()).listDataCenters();
    },

    async listNetworkVolumes(): Promise<RunpodNetworkVolume[]> {
      return (await runpodClient()).listNetworkVolumes();
    },

    async createNetworkVolume(input: unknown): Promise<RunpodNetworkVolume> {
      const parsed = parseWithSchema(createNetworkVolumeInputSchema, input, "create network volume");
      return (await runpodClient()).createNetworkVolume({ name: parsed.name, dataCenterId: parsed.datacenterId, sizeGb: parsed.sizeGb });
    },

    async listTemplates() {
      return (await runpodClient()).listTemplates();
    },

    async listCpuTypes() {
      return (await runpodClient()).listCpuTypes();
    },

    /** Operator-authored template body (scripts/media/template-create.sh); `public`/`serverless` cannot be true. */
    async createTemplate(input: unknown) {
      const parsed = parseWithSchema(createTemplatePassthroughSchema, input, "create template");
      return (await runpodClient()).createTemplate(parsed as Record<string, unknown>);
    },

    // -- Pod passthrough for the operator CLI / slice 0 (sessions are slice 2) -----------------

    async listPods(): Promise<Array<RunpodPod & { comfyUiProxyUrl: string }>> {
      return (await runpodClient()).listPods().then((pods) => pods.map(withProxyUrl));
    },

    async getPod(podId: string): Promise<(RunpodPod & { comfyUiProxyUrl: string }) | null> {
      const pod = await (await runpodClient()).getPod(podId);
      return pod ? withProxyUrl(pod) : null;
    },

    async createPod(input: unknown): Promise<RunpodPod & { comfyUiProxyUrl: string }> {
      const parsed = parseWithSchema(createPodPassthroughSchema, input, "create pod");
      return withProxyUrl(await (await runpodClient()).createPod(parsed as CreatePodInput));
    },

    async terminatePod(podId: string) {
      return (await runpodClient()).terminatePod(podId);
    },

    // -- S3 passthrough (operator CLI; the exchange component is slice 3) ------------------------

    async s3(): Promise<RunpodS3Client> {
      const s3Client = await s3ClientIfConfigured();
      if ("skipped" in s3Client) {
        throw new DomainError({ code: "media_generation_not_configured", message: `S3 access is not available: ${s3Client.skipped}.` });
      }
      return s3Client.client;
    },
  };
}

export type MediaGenerationServices = ReturnType<typeof createMediaGenerationServices>;
