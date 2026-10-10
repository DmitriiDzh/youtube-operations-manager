import { decryptSecret, decryptWithPassword, encryptSecret, encryptWithPassword, type EncryptedPayload, type ScryptParams } from "@/lib/shared-crypto";
import type { CreatePodInput, RunpodAccountBalance, RunpodApiClient, RunpodDataCenter, RunpodGpuType, RunpodNetworkVolume, RunpodPod, RunpodS3Client, RunpodS3Config } from "@/lib/media-gateway";
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
import { buildGpuAvailability, gpuAvailabilityInputSchema, type GpuAvailability } from "./gpu-availability";
import { findLivePodByName, terminateAndConfirm } from "./pod-lifecycle";
import type { VolumeLock } from "./volume-lock";
import { sleep } from "@/lib/shared-async";

const PASSTHROUGH_STOP_TIMEOUT_MS = 90_000;
const PASSTHROUGH_STOP_POLL_MS = 5_000;
import {
  createNetworkVolumeInputSchema,
  CREDENTIALS_FILE_FORMAT,
  exportCredentialsInputSchema,
  importCredentialsInputSchema,
  type CredentialsFile,
  type SetCredentialsInput,
  resizeNetworkVolumeInputSchema,
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
  /** BL-137: scrypt cost for an exported credentials file; omitted = `PASSWORD_SCRYPT_PARAMS` (tests pass a cheap one). */
  passwordScrypt?: ScryptParams;
  keyFile: KeyFile;
  /** Gateway factories (`src/lib/media-gateway/`), injected so tests never touch the network. */
  gateway: {
    createRunpodClient(apiKey: string): RunpodApiClient;
    createS3Client(config: RunpodS3Config): RunpodS3Client;
  };
  clock: { now(): Date };
  /** Who holds the volume lock right now (a session or pull still active), or null -- late-bound by the core. */
  activeVolumeHolder?: () => Promise<string | null>;
  /** The volume lock itself, for the operator pod passthrough (an operator pod mounting the volume is a writer too). */
  volumeLock?: VolumeLock;
  /** For the terminate passthrough's confirm polling (tests inject a clock-advancing one). */
  sleep?: (ms: number) => Promise<void>;
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
  const log = deps.log ?? (() => undefined);
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
    log(`[media] stored settings partly invalid; kept the valid keys, defaulted: ${dropped.join(", ") || "(none)"}`);
    const salvagedResult = mediaSettingsSchema.safeParse(salvaged);
    return salvagedResult.success ? salvagedResult.data : { ...DEFAULT_MEDIA_SETTINGS };
  }

  /** Refuses an action that would remove the only path able to terminate a billing pod while one is open. */
  async function assertVolumeFree(action: string): Promise<void> {
    if (!deps.activeVolumeHolder) return;
    const holder = await deps.activeVolumeHolder();
    if (!holder) return;
    const what = holder.startsWith("pull:") ? "a model pull is running" : holder.startsWith("pod:") ? "an operator pod has the volume mounted" : "a generation session is open";
    throw new DomainError({
      code: "media_session_conflict",
      message: `Cannot ${action} while ${what} (${holder}): the pod could then never be terminated, or its files never received. Stop it first.`,
      details: { holder },
    });
  }

  async function credentialsStatus(): Promise<MediaCredentialsStatus> {
    const row = await deps.store.getCredentials();
    if (!row) return { configured: false, reason: "no_credentials" };
    // AC-P14-21: a row with no key file on this device is "not configured" -- no decryption attempt. A key file that
    // cannot be read (truncated, hand-edited) is reported, never thrown: the card must still render so the operator can
    // reset (review round 16).
    try {
      if ((await deps.keyFile.readKey()) === null) return { configured: false, reason: "key_file_missing" };
    } catch (error) {
      if (error instanceof DomainError && error.code === "encryption_key_not_configured") return { configured: false, reason: "key_file_invalid" };
      throw error;
    }
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
          ? "No RunPod credentials are configured on this device (Settings → RunPod)."
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

  /** Encrypts the whole set under the device key (created on first use) and resets `verifiedAt` (typed or imported keys). */
  async function storeCredentials(parsed: SetCredentialsInput): Promise<MediaCredentialsStatus> {
    await assertVolumeFree("change the RunPod credentials");
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
  }

  return {
    async getOverview(): Promise<MediaGenerationOverview> {
      const [credentials, settings, gatewayEnabled] = await Promise.all([credentialsStatus(), readSettings(), deps.store.getGatewayEnabled()]);
      const missing: string[] = [];
      if (!credentials.configured) missing.push("RunPod credentials");
      // Outputs travel over the S3 API only: without the key pair a job could be approved, generated and never received
      // (review round 13) -- so the pair is part of "ready", like the other inputs.
      else if (!credentials.s3AccessKeyId) missing.push("S3 key pair (RunPod → Settings → S3 API keys)");
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
      return storeCredentials(parseWithSchema(setCredentialsInputSchema, input, "media credentials"));
    },

    /**
     * BL-137: this device's credentials as a file encrypted under `password` (scrypt + AES-256-GCM, `shared-crypto`). The file
     * carries only the public hints in clear (key prefix, S3 key id); the password is not stored anywhere.
     */
    async exportCredentials(input: unknown): Promise<{ file: CredentialsFile }> {
      const { password } = parseWithSchema(exportCredentialsInputSchema, input, "export credentials");
      const secrets = await requireSecrets();
      const encrypted = await encryptWithPassword(JSON.stringify(secrets), password, deps.passwordScrypt);
      return {
        file: {
          format: CREDENTIALS_FILE_FORMAT,
          version: 1,
          createdAt: deps.clock.now().toISOString(),
          hints: { runpodKeyPrefix: `${secrets.runpodApiKey.slice(0, RUNPOD_KEY_PREFIX_LENGTH)}…`, s3AccessKeyId: secrets.s3AccessKeyId },
          encrypted,
        },
      };
    },

    /**
     * BL-137: imports an exported credentials file. A wrong password or a damaged file changes nothing; the RunPod key is
     * checked with one read before anything is stored; then the keys are saved exactly like typed ones (this device's key
     * file, the same "volume busy" refusal).
     */
    async importCredentials(input: unknown): Promise<MediaCredentialsStatus> {
      const { file, password } = parseWithSchema(importCredentialsInputSchema, input, "import credentials");
      let plaintext: string;
      try {
        plaintext = await decryptWithPassword(file.encrypted, password);
      } catch {
        throw new DomainError({ code: "validation_failed", message: "Wrong password, or the credentials file is damaged. Nothing was changed." });
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(plaintext);
      } catch {
        throw new DomainError({ code: "validation_failed", message: "The credentials file is damaged. Nothing was changed." });
      }
      const parsed = parseWithSchema(setCredentialsInputSchema, decoded, "imported credentials");
      await assertVolumeFree("change the RunPod credentials");
      try {
        await deps.gateway.createRunpodClient(parsed.runpodApiKey).verifyKey();
      } catch (error) {
        // Only a rejected key is "invalid"; the gateway toggle, a 403 scope, RunPod being down keep their own code (review).
        if (error instanceof DomainError && error.code !== "media_credentials_invalid") {
          throw new DomainError({ code: error.code, message: `${error.message} The import was not saved.`, details: error.details });
        }
        throw new DomainError({
          code: "media_credentials_invalid",
          message: `RunPod did not accept the imported API key (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`,
        });
      }
      return storeCredentials(parsed);
    },

    /**
     * Clears the row. The device key file stays (AC-P14-21) -- except when it is UNREADABLE: then it is removed with
     * the row it protected, so the next save starts a fresh key (the only remedy for a corrupt file, review round 16).
     */
    async clearCredentials(): Promise<MediaCredentialsStatus> {
      await assertVolumeFree("clear the RunPod credentials");
      await deps.store.clearCredentials();
      try {
        await deps.keyFile.readKey();
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "encryption_key_not_configured")) throw error;
        await deps.keyFile.removeKey();
      }
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
      // The volume and the datacenter are what an open session's pod and an in-flight transfer/pull are bound to:
      // `s3()` re-reads the settings on every call, so switching them mid-flight would make every later transfer look
      // at the wrong volume (review round 14). Everything else (GPU, template, limits) only affects future sessions.
      if ((update.networkVolumeId !== undefined && update.networkVolumeId !== current.networkVolumeId) || (update.datacenterId !== undefined && update.datacenterId !== current.datacenterId)) {
        await assertVolumeFree("change the network volume or datacenter");
      }
      if (update.gpuTypeId === null) next.gpuOnDemandPricePerHr = null;

      // RunPod's network volumes exist on Secure Cloud only (as the Compute card itself says): a Community pod could not
      // mount one, so the pair is refused here, not by a failed createPod after a human approved (review round 16).
      if (next.cloudType === "COMMUNITY" && next.networkVolumeId) {
        throw new DomainError({ code: "media_settings_invalid", message: "Community Cloud pods cannot mount a network volume; choose Secure Cloud or clear the network volume.", details: { field: "cloudType" } });
      }
      // Only a CHANGED field is re-validated against the live catalog -- the Compute card resends every field on save,
      // and an unchanged form must not cost three RunPod reads (review round 16). Computed ONCE as a set, never by
      // rewriting the caller's update (review round 19): a changed cloud type or datacenter re-validates and re-prices
      // the kept GPU as well (AC-P14-19, review round 10).
      const changed = (key: "gpuTypeId" | "datacenterId" | "networkVolumeId" | "templateId" | "cloudType") => update[key] !== undefined && update[key] !== current[key];
      const revalidate = new Set<"gpuTypeId" | "datacenterId" | "networkVolumeId" | "templateId">();
      if (changed("gpuTypeId") && next.gpuTypeId) revalidate.add("gpuTypeId");
      // "Save the GPU again" must be able to repair a missing price (review round 20): an unchanged GPU whose stored price
      // is unknown is re-priced too.
      if (update.gpuTypeId !== undefined && next.gpuTypeId && next.gpuOnDemandPricePerHr === null) revalidate.add("gpuTypeId");
      if (changed("datacenterId") && next.datacenterId) revalidate.add("datacenterId");
      if (changed("networkVolumeId") && next.networkVolumeId) revalidate.add("networkVolumeId");
      if (changed("templateId") && next.templateId) revalidate.add("templateId");
      if ((changed("cloudType") || revalidate.has("datacenterId")) && next.gpuTypeId) revalidate.add("gpuTypeId");
      if (revalidate.size > 0) {
        const client = await runpodClient();
        if (next.datacenterId && revalidate.has("datacenterId")) {
          const datacenters = await client.listDataCenters();
          if (!datacenters.some((dc) => dc.id === next.datacenterId)) {
            throw new DomainError({ code: "media_settings_invalid", message: `Datacenter ${next.datacenterId} is not in RunPod's catalog.`, details: { field: "datacenterId" } });
          }
        }
        if (next.gpuTypeId && revalidate.has("gpuTypeId")) {
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
        if (next.templateId && revalidate.has("templateId")) {
          // The fourth value createPod depends on (review round 12): a deleted or mistyped template is refused here, not
          // by a failed createPod after a human approved a session.
          const templates = await client.listTemplates();
          if (!templates.some((t) => t.id === next.templateId)) {
            throw new DomainError({ code: "media_settings_invalid", message: `Pod template "${next.templateId}" is not in your RunPod account's templates.`, details: { field: "templateId" } });
          }
        }
        if (next.networkVolumeId && (revalidate.has("networkVolumeId") || revalidate.has("datacenterId"))) {
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
     * enforced and the pod would bill until the toggle came back. Refused while the volume lock has an active holder
     * (the same guard covers the credentials and the volume/datacenter settings, review round 14).
     */
    async setGatewayEnabled(enabled: boolean): Promise<void> {
      if (!enabled) await assertVolumeFree("disable the media gateway");
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

    async listGpuTypes(options: { minCudaVersion?: string } = {}): Promise<RunpodGpuType[]> {
      const settings = await readSettings();
      return (await runpodClient()).listGpuTypes({ cloud: settings.cloudType, ...(options.minCudaVersion ? { minCudaVersion: options.minCudaVersion } : {}) });
    },

    /**
     * BL-172 (FO-REQ-0016 A): RunPod's GPU stock and price per datacenter now, with the volume's datacenter and the network-volume and S3
     * facts of each datacenter -- two live catalog reads (no pod, no cost), with the Settings' cloud and CUDA filter unless the input
     * names another CUDA version.
     */
    async getGpuAvailability(input: unknown = {}): Promise<GpuAvailability> {
      const parsed = parseWithSchema(gpuAvailabilityInputSchema, input ?? {}, "GPU availability input");
      const settings = await readSettings();
      const minCudaVersion = parsed.minCudaVersion ?? settings.minCudaVersion ?? undefined;
      const client = await runpodClient();
      const [gpus, dataCenters] = await Promise.all([
        client.listGpuTypes({ cloud: settings.cloudType, ...(minCudaVersion ? { minCudaVersion } : {}) }),
        client.listDataCenters(),
      ]);
      return buildGpuAvailability({ gpus, dataCenters, input: parsed, settings, now: deps.clock.now() });
    },

    /** Slice 6 (AC-P14-25): the account balance (legacy GraphQL), or the v2 billing spend when that read fails. */
    async getAccountBalance(): Promise<RunpodAccountBalance> {
      return (await runpodClient()).getAccountBalance();
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

    /**
     * Grows a network volume (owner request, Telegram 2026-10-06). RunPod never shrinks a volume, so a size that is not larger
     * than the volume's current size -- read live from RunPod, not from a cached list -- is refused before any write.
     */
    async resizeNetworkVolume(input: unknown): Promise<RunpodNetworkVolume> {
      const parsed = parseWithSchema(resizeNetworkVolumeInputSchema, input, "resize network volume");
      const client = await runpodClient();
      const current = await client.getNetworkVolume(parsed.volumeId);
      if (!current) throw new DomainError({ code: "not_found", message: "No network volume with this id on the RunPod account", details: { volumeId: parsed.volumeId } });
      if (parsed.sizeGb <= current.sizeGb) {
        throw new DomainError({
          code: "validation_failed",
          message: `RunPod can only grow a network volume: the new size must be larger than its current ${current.sizeGb} GB`,
          details: { volumeId: parsed.volumeId, currentSizeGb: current.sizeGb, requestedSizeGb: parsed.sizeGb },
        });
      }
      return client.resizeNetworkVolume(parsed.volumeId, parsed.sizeGb);
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

    /**
     * Operator passthrough (CLI `pod-create`, the scripts). A pod that mounts the configured network volume is one more
     * writer of that volume: it takes the same lock as sessions and pulls (`pod:<name>`, review round 13), held until
     * the pod is gone (the lock's staleness check asks RunPod whether a live pod of that name still exists).
     */
    async createPod(input: unknown): Promise<RunpodPod & { comfyUiProxyUrl: string }> {
      const parsed = parseWithSchema(createPodPassthroughSchema, input, "create pod");
      const settings = await readSettings();
      const mountsConfiguredVolume = Boolean(settings.networkVolumeId && parsed.mounts?.network?.some((m) => m.volumeId === settings.networkVolumeId));
      const owner = mountsConfiguredVolume && deps.volumeLock ? (`pod:${parsed.name}` as const) : null;
      const client = await runpodClient(); // credentials must resolve BEFORE the lock is taken (review round 19)
      if (owner && (await deps.volumeLock!.acquire(owner)) === "already-held") {
        throw new DomainError({ code: "media_session_conflict", message: `A pod named ${parsed.name} already holds the network volume; terminate it first (media pod-terminate).`, details: { holder: owner } });
      }
      try {
        return withProxyUrl(await client.createPod(parsed as CreatePodInput));
      } catch (error) {
        // The call can fail AFTER RunPod created the pod (timeout, dropped connection): the lock is released only when the
        // deterministic name finds no live pod; unknown (RunPod unreachable) keeps it (review round 18).
        if (owner) {
          const orphan = await findLivePodByName(client, parsed.name).then((p) => p ?? null, () => undefined);
          if (orphan === null) await deps.volumeLock!.release(owner);
          else if (orphan) log(`[media] createPod failed but pod ${orphan.id} (${parsed.name}) exists; the volume lock stays with it`);
        }
        throw error;
      }
    },

    async terminatePod(podId: string) {
      const client = await runpodClient();
      const pod = await client.getPod(podId).catch(() => null);
      // The same terminate-and-confirm step every other lock owner waits for (review round 15): the volume is freed only
      // once RunPod confirms the pod is gone, never while the container is still tearing down (and flushing).
      const outcome = await terminateAndConfirm(client, podId, { now: () => deps.clock.now(), sleep: deps.sleep ?? sleep }, { timeoutMs: PASSTHROUGH_STOP_TIMEOUT_MS, pollMs: PASSTHROUGH_STOP_POLL_MS });
      if (deps.volumeLock && outcome.confirmed) {
        // Release the pod's lock: by name when the pod was still listed, otherwise (already gone before this call, so its
        // name is unknown) whenever the held `pod:<name>` no longer has a live pod behind it.
        const holder = await deps.volumeLock.holder();
        if (holder?.owner.startsWith("pod:")) {
          const heldName = holder.owner.slice("pod:".length);
          const stillLive = pod?.name === heldName ? false : await findLivePodByName(client, heldName).then((p) => Boolean(p), () => true);
          if (!stillLive) await deps.volumeLock.release(holder.owner as `pod:${string}`);
        }
      }
      return { terminated: true as const, alreadyGone: outcome.alreadyGone, confirmed: outcome.confirmed, lastStatus: outcome.lastStatus };
    },

    // -- S3 passthrough (operator CLI; the exchange component is slice 3) ------------------------

    /**
     * BL-136: an S3 client for ANOTHER network volume of the configured datacenter, with the stored key pair (RunPod's S3 keys
     * are per account, the bucket is the volume id). Used only by the volume migration and its probe.
     */
    async s3ForVolume(volumeId: string): Promise<RunpodS3Client> {
      const secrets = await requireSecrets();
      const settings = await readSettings();
      if (!secrets.s3AccessKeyId || !secrets.s3SecretAccessKey) throw new DomainError({ code: "media_generation_not_configured", message: "S3 access is not available: no S3 key pair is stored." });
      if (!settings.datacenterId) throw new DomainError({ code: "media_generation_not_configured", message: "S3 access is not available: the datacenter is not set." });
      return deps.gateway.createS3Client({ datacenterId: settings.datacenterId, volumeId, accessKeyId: secrets.s3AccessKeyId, secretAccessKey: secrets.s3SecretAccessKey });
    },

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
