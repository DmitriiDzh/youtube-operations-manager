"use client";

import { CLOUD_CREDENTIALS_IMPORTED_EVENT } from "./cloud-credentials-transfer";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";
import {
  MAX_CONCURRENT_SESSIONS_RANGE,
  MEDIA_CUDA_VERSIONS,
  NETWORK_VOLUME_USD_PER_GB_MONTH,
  type MediaCredentialsStatus,
  type MediaGenerationOverview,
  type MediaJob,
  type MediaSession,
  type MediaSessionLimits,
  type MediaCapacityAttempt,
  type MediaControlEventView,
  type MediaKind,
  type MediaModelEntry,
  type MediaSettings,
  type MediaStorageStatus,
  type MediaTemplateSyncResult,
  type MediaVolumeUsage,
  type MediaWorkflowTemplate,
} from "@/lib/media-generation/contracts";
import type { PoolDevice, PoolJob, PoolView } from "@/lib/media-jobs-pool/contracts";
import type { CommandView } from "@/lib/media-jobs-pool/commands";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { ConfirmDialog } from "./confirm-dialog";
import { MEDIA_JOBS_CHANGED_EVENT } from "./gemini-media-create";
import { useChannelNames } from "./use-channel-names";
import { GatewayTrafficStats, type GatewayTrafficWindowView } from "./gateway-traffic-stats";
import { InfoTooltip } from "./info-tooltip";
import { SettingsSectionRow } from "./settings-section-row";
import { ToggleSwitch } from "./toggle-switch";
import { describeSessionJobCounts, fromSharedProgress, JobProgress } from "./media-job-progress";
import type { SharedSessionJobs } from "@/lib/sync-gateway";
import { VolumeUsageBar, volumeUsageBreakdown } from "./volume-usage-bar";
import { useUiText } from "./ui-text-provider";
import { isUiTextKey, type Translate, type UiTextKey } from "@/lib/ui-text";

/** A session, job or model-download status in words (`media.status.*`); an unknown status is shown as it came. */
function mediaStatusLabel(t: Translate, status: string): string {
  const key = `media.status.${status}`;
  return isUiTextKey(key) ? t(key) : status;
}

/** A RunPod pod status in words (`media.podStatus.*`); RunPod may report others, shown as they came. */
function podStatusLabel(t: Translate, status: string): string {
  const key = `media.podStatus.${status}`;
  return isUiTextKey(key) ? t(key) : status;
}

// Phase 14 slice 1 (docs/roadmap/plans/PHASE_14_PLAN.md §2.6/§2.9, owner decision D5): the operator
// enters RunPod keys here (stored encrypted per device, never shown again), picks datacenter / GPU /
// volume / template from RunPod's live lists, and sets the spend and watcher limits. Every RunPod
// call behind the setup cards is an explicit click ("Load", "Test", "Create"), never on mount.
//
// Slice 6 (owner, Telegram 2026-10-05, msg 1549): Settings → Cloud APIs keeps ONLY the connection (`RunpodConnectionSettings`);
// everything else is the Production section (`production-panel.tsx`), which uses the cards exported below.

// The core's own public shapes (review round 16): never a hand copy that drifts when contracts.ts changes.
type CredentialsStatus = MediaCredentialsStatus;
type Settings = MediaSettings;
type Overview = MediaGenerationOverview;

type Gpu = {
  id: string;
  displayName: string;
  memoryInGb: number | null;
  onDemandPricePerHr: number | null;
  estimatedAvailability: string | null;
  secureCloud: boolean;
  communityCloud: boolean;
  dataCenters: Array<{ id: string; estimatedAvailability: string | null }>;
};
type DataCenter = { id: string; countryCode: string | null; region: string | null; networkVolumeTypes: string[] };
type Volume = { id: string; name: string; dataCenterId: string; sizeGb: number; usedSizeGb: number | null };
type Template = { id: string; name: string };
type TestResult = { runpod: { ok: true } | { ok: false; message: string }; s3: { ok: true } | { ok: false; message: string } | { skipped: true; reason: string }; verifiedAt: string | null };


async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  // ui-text-ignore: technical fallback naming the endpoint, shown only when the server sends no message of its own
  if (!res.ok) throw new Error((data as { message?: string }).message ?? `Request to ${url} failed (${res.status})`);
  return data as T;
}

const MONEY: Intl.NumberFormatOptions = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
type FormatNumber = (value: number, options?: Intl.NumberFormatOptions) => string;

/** A byte count as GB / MB / B in the interface language. */
function sizeLabel(t: Translate, formatNumber: FormatNumber, bytes: number): string {
  if (bytes >= 1024 ** 3) return t("unit.gb", { value: formatNumber(bytes / 1024 ** 3, MONEY) });
  if (bytes >= 1024 ** 2) return t("media.size.mb", { value: formatNumber(bytes / 1024 ** 2, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
  return t("media.size.bytes", { value: bytes });
}

/** The interface text plus this file's two number shapes: dollars with cents, and byte sizes. */
function useMediaText() {
  const { t, formatNumber } = useUiText();
  return { t, formatNumber, usd: (value: number) => formatNumber(value, MONEY), gb: (bytes: number) => sizeLabel(t, formatNumber, bytes) };
}

const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none";

/**
 * Money fields are controlled TEXT inputs (never `type="number"`, whose decimal separator is browser-locale dependent and
 * which turns a cleared field into 0 -- the project's standing rule for settings widgets): "2.5" and "2,5" both parse;
 * anything else, or a non-positive value, is null and the form says so instead of saving 0.
 */
/** Integer counts (minutes, seconds, GB) follow the same rule: a controlled text field, parsed and range-checked on save. */
export function parseInteger(text: string, range: { min: number; max: number }): number | null {
  const normalized = text.trim();
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isSafeInteger(value) && value >= range.min && value <= range.max ? value : null;
}

export function parseMoney(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0 ? value : null;
}
const primaryButton = "rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50";
const secondaryButton = "rounded-md border border-zinc-700 bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50";
const dangerButton = "rounded-md border border-red-900 bg-red-950/50 px-4 py-1.5 text-sm font-medium text-red-400 hover:bg-red-950 disabled:opacity-50";

function Card({ title, help, children }: { title: string; help: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
        {title}
        <InfoTooltip>{help}</InfoTooltip>
      </h3>
      {children}
    </div>
  );
}

/** The media overview (credentials, settings, readiness) and the gateway traffic, shared by Settings → Cloud APIs and Production. */
/**
 * BL-150 review: a card sends only the fields that differ from the settings it shows -- never a field the owner did not touch.
 * Setup is shared with the other computers: re-sending a field's old value (a form opened before the other computer changed it)
 * would publish that old value as a fresh edit and silently undo the other computer's change, a spend limit included.
 * `keep` names fields always sent (e.g. the GPU, whose re-save repairs a missing price).
 */
export function onlyChangedSettings(patch: Record<string, unknown>, loaded: Settings, keep: readonly string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([field, value]) => keep.includes(field) || JSON.stringify(value ?? null) !== JSON.stringify((loaded as Record<string, unknown>)[field] ?? null)));
}

export function useMediaOverview() {
  const { t } = useUiText();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gatewayTraffic, setGatewayTraffic] = useState<GatewayTrafficWindowView[] | undefined>(undefined);

  // State updates happen in the promise callbacks (the "callback when external state changes"
  // shape the react-hooks/set-state-in-effect rule allows), never synchronously in the effect.
  const fetchOverview = useCallback(
    () =>
      requestJson<Overview>("/api/media-generation/overview").then(
        (data) => {
          setOverview(data);
          setLoadError(null);
        },
        (err: unknown) => {
          setLoadError(err instanceof Error ? err.message : t("media.overview.loadFailed"));
        }
      ),
    [t]
  );

  // Traffic stats are decorative; the cards work without them.
  const fetchTraffic = useCallback(
    () =>
      requestJson<{ gatewayTraffic?: GatewayTrafficWindowView[] }>("/api/settings").then(
        (data) => setGatewayTraffic(data.gatewayTraffic),
        () => undefined
      ),
    []
  );

  const refresh = useCallback(async () => {
    await Promise.all([fetchOverview(), fetchTraffic()]);
  }, [fetchOverview, fetchTraffic]);

  useEffect(() => {
    fetchOverview();
    fetchTraffic();
  }, [fetchOverview, fetchTraffic]);

  return { overview, loadError, gatewayTraffic, refresh };
}

/** Settings → Cloud APIs (slice 6; BL-193 the shared tab): only the RunPod connection -- the API keys and their test. */
export function RunpodConnectionSettings() {
  const { t } = useUiText();
  const { overview, loadError, refresh } = useMediaOverview();
  // BL-193: keys imported from the cloud-keys file (its own card on Settings → Cloud APIs) show here at once.
  useEffect(() => {
    const onImported = () => void refresh();
    window.addEventListener(CLOUD_CREDENTIALS_IMPORTED_EVENT, onImported);
    return () => window.removeEventListener(CLOUD_CREDENTIALS_IMPORTED_EVENT, onImported);
  }, [refresh]);
  if (loadError) return <p className="text-sm text-red-400">{loadError}</p>;
  if (!overview) return <p className="text-sm text-zinc-500">{t("common.loading")}</p>;
  return (
    <div className="space-y-6">
      <CredentialsCard status={overview.credentials} onChanged={refresh} />
      <p className="text-xs text-zinc-500">{t("media.connection.restInProduction")}</p>
    </div>
  );
}

type ModelFile = MediaModelEntry;
type ModelPull = {
  pullId: string;
  podId: string | null;
  repoId: string;
  file: string;
  expectedKey: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  bytes: number | null;
  error: string | null;
  // BL-132: absent on pulls recorded before it.
  revision?: string;
  expectedSha256?: string | null;
  actualSha256?: string | null;
  requestedBy?: "owner" | "factory";
};
const MODEL_FOLDERS = ["checkpoints", "diffusion_models", "text_encoders", "vae", "loras", "clip_vision", "audio_encoders", "upscale_models", "controlnet", "embeddings"];

// Phase 14 slice 4 (owner decision D5): the models on the network volume, and "add from Hugging Face"
// through a cheap CPU pod attached to the volume (terminated as soon as the file is there). Every
// listing is one S3 call, made each time the Models tab is opened (owner, Telegram 2026-10-06, msg 1793) or on Refresh;
// while a pull runs the card refreshes itself.
export function ModelsCard({ configured, active }: { configured: boolean; active: boolean }) {
  const { t, usd, gb } = useMediaText();
  const [models, setModels] = useState<ModelFile[] | null>(null);
  const [pulls, setPulls] = useState<ModelPull[]>([]);
  const [repoId, setRepoId] = useState("");
  const [file, setFile] = useState("");
  const [folder, setFolder] = useState("checkpoints");
  const [revision, setRevision] = useState("");
  const [sha256, setSha256] = useState("");
  const [targetName, setTargetName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelFile | null>(null);
  const [registry, setRegistry] = useState<{ state: "ok" | "unavailable"; error: string | null }>({ state: "ok", error: null });
  const [events, setEvents] = useState<MediaControlEventView[]>([]);
  const [storage, setStorage] = useState<MediaStorageStatus | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [usage, setUsage] = useState<MediaVolumeUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // `withUsage`: the whole-volume listing (BL-136) runs on an explicit Load/Refresh only, never on the pull poll -- it can take
  // longer than the poll interval on a volume with many files (independent review).
  const load = useCallback(
    (withUsage = true) => {
      // The 15 s pull poll (withUsage = false) refreshes quietly, without flipping the button.
      if (withUsage) setLoading(true);
      return Promise.all([
        requestJson<{ models: ModelFile[]; pulls: ModelPull[]; registry: "ok" | "unavailable"; registryError: string | null; events: MediaControlEventView[] }>("/api/media-generation/models").then(
          (data) => {
            setModels(data.models);
            setPulls(data.pulls);
            setRegistry({ state: data.registry, error: data.registryError });
            setEvents(data.events);
            setError(null);
          },
          (err: unknown) => setError(err instanceof Error ? err.message : t("media.models.listFailed"))
        ),
        // The volume's size comes from RunPod, not S3: a failure there must not hide the listing.
        requestJson<{ storage: MediaStorageStatus }>("/api/media-generation/storage").then(
          (data) => {
            setStorage(data.storage);
            setStorageError(null);
          },
          (err: unknown) => setStorageError(err instanceof Error ? err.message : t("media.models.sizeFailed"))
        ),
        // BL-136: the whole volume's use (one S3 listing); its failure leaves the bar with the model files only.
        withUsage
          ? requestJson<{ usage: MediaVolumeUsage }>("/api/media-generation/storage/usage").then(
              (data) => {
                setUsage(data.usage);
                setUsageError(null);
              },
              (err: unknown) => {
                setUsage(null);
                setUsageError(err instanceof Error ? err.message : t("media.models.usageFailed"));
              }
            )
          : Promise.resolve(),
      ])
        .then(() => undefined)
        .finally(() => {
          if (withUsage) setLoading(false);
        });
    },
    [t]
  );

  // Every Production tab stays mounted (hidden by CSS), so "the owner opened Models" is `active` turning true.
  useEffect(() => {
    if (!active || !configured) return;
    void load();
  }, [active, configured, load]);

  const pulling = pulls.some((p) => p.status === "running");
  useEffect(() => {
    if (!pulling) return;
    const timer = setInterval(() => void load(false), 15_000);
    return () => clearInterval(timer);
  }, [pulling, load]);

  async function startPull() {
    setBusy(true);
    setError(null);
    try {
      await requestJson("/api/media-generation/models/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoId: repoId.trim(),
          file: file.trim(),
          folder,
          ...(revision.trim() ? { revision: revision.trim() } : {}),
          ...(sha256.trim() ? { sha256: sha256.trim() } : {}),
          ...(targetName.trim() ? { targetName: targetName.trim() } : {}),
        }),
      });
      setFile("");
      setTargetName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.models.pullFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function cancelPull(pull: ModelPull) {
    setBusy(true);
    try {
      await requestJson(`/api/media-generation/models/pull/${encodeURIComponent(pull.pullId)}/cancel`, { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.models.cancelPullFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    setBusy(true);
    try {
      await requestJson("/api/media-generation/models", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: target.key }) });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.models.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  const totalBytes = (models ?? []).reduce((sum, m) => sum + m.bytes, 0);
  const usedByText = (m: ModelFile) =>
    m.usedBy.map((u) => t(u.source === "owner" ? "media.models.usedByLocal" : "media.models.usedByEntry", { template: u.templateId, version: String(u.version) })).join(", ");

  return (
    <Card
      title={t("media.models.title")}
      help={t("media.models.help")}
    >
      {!configured ? (
        <p className="text-xs text-zinc-500">{t("media.models.notConfigured")}</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void load()} disabled={busy || loading} className={secondaryButton}>
              {loading ? t("common.loading") : models ? t("media.common.refresh") : t("media.models.load")}
            </button>
            {models && (
              <span className="text-xs text-zinc-500">
                {t("media.models.summary", { count: models.length, size: gb(totalBytes), usd: usd((totalBytes / 1024 ** 3) * NETWORK_VOLUME_USD_PER_GB_MONTH) })}
              </span>
            )}
          </div>
          {storage && models && <VolumeUsageBar breakdown={volumeUsageBreakdown({ rentedGb: storage.sizeGb, models, usage })} />}
          {usageError && <p className="text-xs text-amber-400">{t("media.models.usageError", { error: usageError })}</p>}
          {storage && (
            <p className="text-xs text-zinc-400">
              {t("media.models.storageLine", {
                volume: storage.volumeId,
                dataCenter: storage.dataCenterId ? ` (${storage.dataCenterId})` : "",
                size: storage.sizeGb,
                usage: storage.usedGb !== null ? t("media.models.storageUsage", { used: storage.usedGb, free: storage.freeGb ?? 0 }) : "",
                usd: usd(storage.monthlyUsd),
              })}
            </p>
          )}
          {storageError && <p className="text-xs text-amber-400">{t("media.models.sizeError", { error: storageError })}</p>}
          {models && registry.state === "unavailable" && (
            <p className="text-xs text-amber-400">{t("media.models.registryUnavailable", { error: registry.error ?? "" })}</p>
          )}
          {models && models.length > 0 && (
            <div className="overflow-x-auto">
              <table className="min-w-[560px] w-full text-left text-xs text-zinc-400">
                <thead>
                  <tr className="text-zinc-500">
                    <th className="py-1 pr-3">{t("media.models.colFolder")}</th>
                    <th className="py-1 pr-3">{t("media.models.colFile")}</th>
                    <th className="py-1 pr-3">{t("media.models.colSize")}</th>
                    <th className="py-1 pr-3">{t("media.models.colSha")}</th>
                    <th className="py-1 pr-3">{t("media.models.colUsedBy")}</th>
                    <th className="py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.key} className="border-t border-zinc-800">
                      <td className="py-1 pr-3">{m.folder}</td>
                      <td className="py-1 pr-3 font-mono">{m.name}</td>
                      <td className="py-1 pr-3 whitespace-nowrap">{gb(m.bytes)}</td>
                      <td className="py-1 pr-3 font-mono" title={m.sha256 ?? t("media.models.shaNotVerified")}>
                        {m.sha256 ? `${m.sha256.slice(0, 12)}…` : "—"}
                      </td>
                      <td className="py-1 pr-3">
                        {m.usedBy.length === 0 ? "—" : usedByText(m)}
                      </td>
                      <td className="py-1">
                        <button type="button" onClick={() => setDeleteTarget(m)} disabled={busy} className={dangerButton}>
                          {t("media.common.delete")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {pulls.length > 0 && (
            <ul className="space-y-1 text-xs text-zinc-400">
              {pulls.slice(0, 5).map((p) => (
                <li key={p.pullId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5">
                  <span>
                    <span className={p.status === "running" ? "text-amber-400" : p.status === "done" ? "text-emerald-400" : "text-red-400"}>{mediaStatusLabel(t, p.status)}</span>
                    {" · "}
                    <span className="font-mono">{p.repoId}/{p.file}</span>
                    {" → "}
                    {p.expectedKey}
                    {p.bytes !== null ? ` · ${gb(p.bytes)}` : ""}
                    {p.actualSha256 && p.status === "done" ? t("media.models.pullShaVerified", { hash: p.actualSha256.slice(0, 12) }) : ""}
                    {p.requestedBy === "factory" ? t("media.models.pullByFactory") : ""}
                    {p.error ? ` · ${p.error}` : ""}
                    {p.podId ? t("media.models.pullPod", { pod: p.podId }) : t("media.models.pullReserving")}
                  </span>
                  {p.status === "running" && (
                    <button type="button" onClick={() => cancelPull(p)} disabled={busy} className={secondaryButton}>
                      {t("common.cancel")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-2 sm:grid-cols-4">
            <label className="block text-xs text-zinc-400">
              {t("media.models.repo")}
              {/* ui-text-ignore: a sample Hugging Face repository id */}
              <input type="text" value={repoId} onChange={(e) => setRepoId(e.target.value)} className={inputClass} placeholder="Comfy-Org/flux1-schnell" />
            </label>
            <label className="block text-xs text-zinc-400">
              {t("media.models.fileInRepo")}
              <input type="text" value={file} onChange={(e) => setFile(e.target.value)} className={inputClass} placeholder="flux1-schnell-fp8.safetensors" />
            </label>
            <label className="block text-xs text-zinc-400">
              {t("media.models.folder")}
              <select value={folder} onChange={(e) => setFolder(e.target.value)} className={inputClass}>
                {MODEL_FOLDERS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-zinc-400">
              {t("media.models.revision")}
              <input type="text" value={revision} onChange={(e) => setRevision(e.target.value)} className={inputClass} placeholder="main" />
            </label>
            <label className="block text-xs text-zinc-400 sm:col-span-2">
              {t("media.models.expectedSha")}
              <input type="text" value={sha256} onChange={(e) => setSha256(e.target.value)} className={`${inputClass} font-mono`} placeholder={t("media.models.shaPlaceholder")} />
            </label>
            <label className="block text-xs text-zinc-400">
              {t("media.models.targetName")}
              <input type="text" value={targetName} onChange={(e) => setTargetName(e.target.value)} className={`${inputClass} font-mono`} placeholder={file.trim() ? (file.trim().split("/").filter(Boolean).pop() ?? "") : t("media.models.targetNamePlaceholder")} />
            </label>
            <div className="flex items-end">
              <button type="button" onClick={startPull} disabled={busy || pulling || !repoId.trim() || !file.trim()} className={primaryButton}>
                {pulling ? t("media.models.pullRunning") : t("media.models.pull")}
              </button>
            </div>
          </div>
          <p className="text-xs text-zinc-500">{t("media.models.licence")}</p>
          {events.length > 0 && (
            <details className="text-xs text-zinc-400">
              <summary className="cursor-pointer text-zinc-500">{t("media.models.events", { count: events.length })}</summary>
              <ul className="mt-1 space-y-0.5">
                {events.map((e, i) => (
                  <li key={`${e.at}-${i}`}>
                    {formatDisplayDateTime(e.at)} · {e.actor === "factory" ? t("media.actor.factory") : e.actor === "sync" ? t("media.actor.sync") : t("media.actor.you")} · {e.action.replace(/_/g, " ")} · <span className="font-mono">{e.subject}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {deleteTarget && (
        <ConfirmDialog
          title={t("media.models.deleteTitle", { name: deleteTarget.name })}
          description={
            deleteTarget.usedBy.length > 0
              ? t("media.models.deleteUsed", { templates: usedByText(deleteTarget) })
              : registry.state === "unavailable"
                ? t("media.models.deleteUnchecked")
                : t("media.models.deleteUnused")
          }
          confirmLabel={t("media.common.delete")}
          confirmVariant="danger"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={remove}
        />
      )}
    </Card>
  );
}

type WorkflowTemplate = MediaWorkflowTemplate;

// Phase 14 slice 3 (owner decision D7): templates are imported by the operator -- a ComfyUI API-format
// graph (Save As (API Format) in ComfyUI) plus the parameters an agent may set. Prompts are job
// parameters, never part of a template.
export function WorkflowTemplatesCard() {
  const { t } = useUiText();
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [name, setName] = useState("");
  const [workflowText, setWorkflowText] = useState("");
  const [parametersText, setParametersText] = useState('[\n  { "name": "prompt", "type": "text", "nodeId": "6", "input": "text", "required": true }\n]');
  const [showImport, setShowImport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkflowTemplate | null>(null);
  const [lastSync, setLastSync] = useState<MediaTemplateSyncResult | null>(null);

  const fetchTemplates = useCallback(
    () =>
      Promise.all([
        requestJson<{ templates: WorkflowTemplate[] }>("/api/media-generation/workflow-templates"),
        requestJson<{ lastSync: MediaTemplateSyncResult | null }>("/api/media-generation/workflow-templates/sync"),
      ]).then(
        ([data, sync]) => {
          setTemplates(data.templates);
          setLastSync(sync.lastSync);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : t("media.templates.loadFailed"))
      ),
    [t]
  );

  async function syncNow() {
    setBusy(true);
    setError(null);
    try {
      await requestJson("/api/media-generation/workflow-templates/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      await fetchTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.templates.syncFailed"));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  async function importTemplate() {
    setBusy(true);
    setError(null);
    try {
      let workflow: unknown;
      let parameters: unknown;
      try {
        workflow = JSON.parse(workflowText);
        parameters = JSON.parse(parametersText);
      } catch {
        throw new Error(t("media.templates.invalidJson"));
      }
      await requestJson("/api/media-generation/workflow-templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, workflow, parameters }),
      });
      setName("");
      setWorkflowText("");
      setShowImport(false);
      await fetchTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.templates.importFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    setBusy(true);
    try {
      await requestJson(`/api/media-generation/workflow-templates/${encodeURIComponent(target.templateId)}`, { method: "DELETE" });
      await fetchTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.templates.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={t("media.templates.title")}
      help={t("media.templates.help")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={syncNow} disabled={busy} className={secondaryButton}>
          {t("media.templates.sync")}
        </button>
        {lastSync && (
          <span className="text-xs text-zinc-500">
            {t("media.templates.lastSync", {
              date: formatDisplayDateTime(lastSync.at),
              trigger: lastSync.trigger === "auto" ? t("media.templates.triggerAuto") : lastSync.trigger === "factory" ? t("media.templates.triggerFactory") : t("media.templates.triggerYou"),
            })}{" "}
            {lastSync.outcome === "unavailable"
              ? t("media.templates.registryUnavailable", { error: lastSync.error ?? "" })
              : [
                  t("media.templates.installed", { count: lastSync.installed.length }),
                  t("media.templates.updated", { count: lastSync.updated.length }),
                  t("media.templates.removed", { count: lastSync.removed.length }),
                  lastSync.pending.length ? t("media.templates.pending", { count: lastSync.pending.length }) : null,
                  lastSync.invalid.length ? t("media.templates.refused", { count: lastSync.invalid.length }) : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
          </span>
        )}
      </div>
      {lastSync && lastSync.invalid.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-400">
          {lastSync.invalid.map((i, index) => (
            <li key={`${i.templateId}.${i.version}.${index}`}>
              {i.templateId} v{i.version}: {i.reason}
            </li>
          ))}
        </ul>
      )}
      {templates.length === 0 ? (
        <p className="text-xs text-zinc-500">{t("media.templates.none")}</p>
      ) : (
        <ul className="space-y-1 text-sm text-zinc-300">
          {templates.map((tpl) => (
            <li key={tpl.templateId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
              <span>
                <span className="font-medium text-zinc-100">{tpl.name}</span>{" "}
                <span className={tpl.source === "factory" ? "rounded bg-sky-950 px-1.5 text-xs text-sky-300" : "rounded bg-zinc-800 px-1.5 text-xs text-zinc-400"}>{tpl.source === "factory" ? t("media.templates.sourceFactory") : t("media.templates.sourceLocal")}</span>{" "}
                <span className="text-xs text-zinc-500">{t("media.templates.meta", { version: String(tpl.version), nodes: tpl.nodeCount, outputs: tpl.outputNodeIds.length, id: tpl.templateId })}</span>
                <br />
                <span className="text-xs text-zinc-500">
                  {tpl.parameters.map((p) => `${p.name}${p.required ? "*" : ""}: ${p.type}`).join(", ") || t("media.templates.noParameters")}
                </span>
              </span>
              {tpl.source === "factory" ? (
                <span className="text-xs text-zinc-500">{t("media.templates.managedByFactory")}</span>
              ) : (
                <button type="button" onClick={() => setDeleteTarget(tpl)} disabled={busy} className={dangerButton}>
                  {t("media.common.delete")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {showImport ? (
        <div className="space-y-2">
          <label className="block text-xs text-zinc-400">
            {t("media.templates.name")}
            {/* ui-text-ignore: a sample template name */}
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="txt2img FLUX" />
          </label>
          <label className="block text-xs text-zinc-400">
            {t("media.templates.workflowJson")}
            {/* ui-text-ignore: a JSON format sample */}
            <textarea value={workflowText} onChange={(e) => setWorkflowText(e.target.value)} className={`${inputClass} h-40 font-mono text-xs`} placeholder='{"3": {"class_type": "KSampler", "inputs": {...}}, ...}' />
          </label>
          <label className="block text-xs text-zinc-400">
            {t("media.common.parametersJson")}
            <textarea value={parametersText} onChange={(e) => setParametersText(e.target.value)} className={`${inputClass} h-28 font-mono text-xs`} />
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={importTemplate} disabled={busy || !name.trim() || !workflowText.trim()} className={primaryButton}>
              {busy ? t("media.common.importing") : t("media.common.import")}
            </button>
            <button type="button" onClick={() => setShowImport(false)} disabled={busy} className={secondaryButton}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setShowImport(true)} className={secondaryButton}>
          {t("media.templates.importOpen")}
        </button>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {deleteTarget && (
        <ConfirmDialog
          title={t("media.templates.deleteTitle", { name: deleteTarget.name })}
          description={t("media.templates.deleteDescription")}
          confirmLabel={t("media.common.delete")}
          confirmVariant="danger"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={remove}
        />
      )}
    </Card>
  );
}

type PoolRow = PoolJob;

/** BL-188: the "Компьютер" filter's value -- every computer, or one by its device id. */
const ALL_DEVICES = "";

/** A computer's name as shown; this computer is marked. Exported for its test. */
export function poolDeviceLabel(t: Translate, device: Pick<PoolDevice, "hostName" | "own">): string {
  const name = device.hostName ?? t("media.pool.unnamedDevice");
  return device.own ? t("media.pool.thisDevice", { name }) : name;
}

/** Whether a job of the shared list is still under way (it keeps the list polling). Exported for its test. */
export function poolJobUnderWay(job: Pick<PoolRow, "source" | "status">): boolean {
  return !(job.source === "runpod" ? ["done", "failed", "cancelled"] : ["done", "failed"]).includes(job.status);
}

const COMMAND_ACTION: Record<CommandView["kind"], UiTextKey> = {
  cancel_job: "media.pool.command.cancel_job",
  create_job: "media.pool.command.create_job",
  approve_session: "media.pool.command.approve_session",
  reject_session: "media.pool.command.reject_session",
};

/** A refusal's code in words where it is one of ours; any other code is shown as it came. */
const REFUSAL_TEXT: Record<string, UiTextKey> = {
  command_expired: "media.pool.refusal.command_expired",
  command_interrupted: "media.pool.refusal.command_interrupted",
  command_failed: "media.pool.refusal.command_failed",
  channel_not_connected: "media.pool.refusal.channel_not_connected",
  CHANNEL_NOT_AUTHORIZED: "media.pool.refusal.channel_mismatch",
  media_session_invalid_state: "media.pool.refusal.session_state",
  media_session_not_found: "media.pool.refusal.not_found",
  media_job_invalid_state: "media.pool.refusal.job_state",
  media_job_not_found: "media.pool.refusal.not_found",
  gemini_job_not_found: "media.pool.refusal.not_found",
  gemini_cancel_too_late: "media.pool.refusal.too_late",
  media_limit_exceeded: "media.pool.refusal.limit",
  storyboard_not_approved: "media.pool.refusal.storyboard",
  // BL-188 stage 4: a Gemini job sent to another computer, refused by that computer's own Gemini checks.
  gemini_disabled: "media.pool.refusal.gemini_disabled",
  gemini_key_missing: "media.pool.refusal.gemini_key_missing",
  gemini_payment_required: "media.pool.refusal.gemini_payment_required",
  gemini_limit_exceeded: "media.pool.refusal.limit",
  gemini_invalid_params: "media.pool.refusal.gemini_invalid_params",
  gemini_input_unavailable: "media.pool.refusal.gemini_input_unavailable",
  gemini_workspace_unavailable: "media.pool.refusal.channel_not_connected",
  validation_failed: "media.pool.refusal.gemini_invalid_params",
};

/**
 * BL-188 stage 2 (SHARED_MEDIA_JOBS_PLAN.md §2.3): an action sent to another computer, in words -- sent and waiting (or that
 * computer is not reporting), in progress, done, refused with the reason, or a run that expired unanswered. Exported for its test.
 */
export function commandStatusText(t: Translate, command: CommandView): string {
  const action = t(COMMAND_ACTION[command.kind]);
  const name = command.targetHostName ?? t("media.pool.unnamedDevice");
  switch (command.state) {
    case "waiting":
      return command.targetOffline
        ? t("media.pool.commandOffline", { action, name, when: command.targetUpdatedAt ? formatDisplayDateTime(command.targetUpdatedAt) : "—" })
        : t("media.pool.commandWaiting", { action, name, when: formatDisplayDateTime(command.issuedAt) });
    case "applying":
      return t("media.pool.commandApplying", { action, name });
    case "applied":
      return command.code === "already_finished" ? t("media.pool.commandAlreadyFinished", { name }) : t("media.pool.commandApplied", { action, name, when: formatDisplayDateTime(command.resultAt ?? command.issuedAt) });
    case "refused": {
      const known = command.code ? REFUSAL_TEXT[command.code] : undefined;
      const reason = known ? t(known) : t("media.pool.refusal.code", { code: command.code ?? "—" });
      return t("media.pool.commandRefused", { action, name, reason });
    }
    case "expired":
      return t("media.pool.commandExpired", { action, name });
  }
}

/** A command still on its way (it keeps the list polling, and hides a second click on the same action). */
export function commandPending(command: Pick<CommandView, "state">): boolean {
  return command.state === "waiting" || command.state === "applying";
}

/** Whether a job of the shared list can be cancelled: a RunPod job not finished, a Gemini job not yet sent to Google. */
export function poolJobCancellable(job: Pick<PoolRow, "source" | "status">): boolean {
  return job.source === "runpod" ? ["queued", "submitted", "generating"].includes(job.status) : job.status === "queued";
}

function CommandLine({ command }: { command: CommandView }) {
  const { t } = useUiText();
  const tone = command.state === "refused" || command.state === "expired" ? "text-amber-300" : command.state === "applied" ? "text-emerald-400" : "text-sky-300";
  return <span className={`block ${tone}`}>{commandStatusText(t, command)}</span>;
}

// Phase 14 slice 3: the operator's own manual job (an agent's arrives through MCP in slice 5) and the job list. BL-188
// (owner msgs 2801/2803/2806): the list is the shared one -- RunPod and Gemini jobs of this computer AND of every other computer,
// for the active channel and the tab's kind, with the computer each runs on. Stage 2: the same actions on every computer -- a
// cancel of another computer's job, or a run on another computer's running session, is sent to that computer, which applies it
// with its own checks and limits; the row says it was sent and then what that computer answered.
export function JobsCard({ activeChannelId, kind = null }: { activeChannelId: string | null; kind?: MediaKind | null }) {
  const { t } = useUiText();
  const [pool, setPool] = useState<PoolView>({ jobs: [], devices: [] });
  const [deviceFilter, setDeviceFilter] = useState(ALL_DEVICES);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  // Slice 6: several sessions may run at once; a job goes to one RUNNING session of the active channel, chosen here.
  const [openSessions, setOpenSessions] = useState<Array<{ sessionId: string; status: string; channelId: string; podId: string | null; createdAt: string }>>([]);
  const [chosenSessionId, setChosenSessionId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [paramsText, setParamsText] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the job list changes every few seconds while a job runs; the templates and the open session are fetched on
  // mount, after an action, and at a slow cadence (review round 11: three endpoints every 5 s for a 2 h job was ~1,400
  // needless requests per hour each).
  const fetchJobs = useCallback(
    () =>
      // BL-157 (AC-SM-03): the active channel's (the server resolves the channel). BL-188: every computer's, of the tab's kind.
      requestJson<PoolView>(`/api/media-jobs?limit=${POOL_LIST_LIMIT}${kind ? `&kind=${kind}` : ""}`).then(
        (view) => setPool(view),
        (err: unknown) => setError(err instanceof Error ? err.message : t("media.jobs.loadFailed"))
      ),
    [t, kind]
  );
  const fetchContext = useCallback(
    () =>
      Promise.all([
        requestJson<{ templates: WorkflowTemplate[] }>("/api/media-generation/workflow-templates"),
        requestJson<{ limits: { openSessions: Array<{ sessionId: string; status: string; channelId: string; podId: string | null; createdAt: string }> } }>("/api/media-generation/sessions"),
      ]).then(
        ([tpl, s]) => {
          setTemplates(tpl.templates);
          setOpenSessions(s.limits.openSessions);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : t("media.jobs.loadFailed"))
      ),
    [t]
  );
  const fetchAll = useCallback(() => Promise.all([fetchJobs(), fetchContext()]).then(() => undefined), [fetchJobs, fetchContext]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // BL-188 stage 4: the Gemini form (same tab) created a job here or sent one to another computer -- show it at once.
  useEffect(() => {
    const onChanged = () => void fetchJobs();
    window.addEventListener(MEDIA_JOBS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MEDIA_JOBS_CHANGED_EVENT, onChanged);
  }, [fetchJobs]);

  const commands = pool.commands ?? [];
  const hasActive = pool.jobs.some(poolJobUnderWay) || commands.some(commandPending);
  // BL-144: while a job generates, its live ComfyUI progress is refreshed every 2 s; otherwise every 5 s as before.
  const generating = pool.jobs.some((j) => j.status === "generating" || j.status === "submitted");
  useEffect(() => {
    if (!hasActive) return;
    const jobsTimer = setInterval(() => void fetchJobs(), generating ? 2_000 : 5_000);
    const contextTimer = setInterval(() => void fetchContext(), 60_000);
    return () => {
      clearInterval(jobsTimer);
      clearInterval(contextTimer);
    };
  }, [hasActive, generating, fetchJobs, fetchContext]);

  /** BL-188 stage 2: an action on another computer's job or session, sent to it (the answer comes back in its report). */
  async function sendCommand(body: Record<string, unknown>) {
    await requestJson("/api/media-jobs/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async function run() {
    if (!activeChannelId || !target) return;
    setBusy(true);
    setError(null);
    try {
      let params: unknown;
      try {
        params = JSON.parse(paramsText || "{}");
      } catch {
        throw new Error(t("media.jobs.invalidJson"));
      }
      if (target.deviceId === null) {
        await requestJson("/api/media-generation/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: target.sessionId, channelId: activeChannelId, templateId, params }),
        });
      } else {
        await sendCommand({ kind: "create_job", targetDeviceId: target.deviceId, sessionId: target.sessionId, templateId, params });
      }
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.jobs.submitFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(job: PoolRow) {
    setBusy(true);
    setError(null);
    try {
      if (!job.own) await sendCommand({ kind: "cancel_job", targetDeviceId: job.deviceId, source: job.source, jobId: job.jobId });
      else if (job.source === "gemini") await requestJson(`/api/gemini-media/jobs/${encodeURIComponent(job.jobId)}/cancel`, { method: "POST" });
      else await requestJson(`/api/media-generation/jobs/${encodeURIComponent(job.jobId)}/cancel`, { method: "POST" });
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.jobs.cancelFailed"));
    } finally {
      setBusy(false);
    }
  }

  // A job is submitted for the active channel, to one of ITS running sessions (review round 16; slice 6: several may run).
  // BL-188 stage 2: this computer's running sessions first, then the other computers' (the run is sent there).
  const runningHere = openSessions.filter((s) => s.status === "running" && s.channelId === activeChannelId);
  const targets: Array<{ key: string; sessionId: string; deviceId: string | null; hostName: string | null; label: string }> = [
    ...runningHere.map((s) => ({ key: `own:${s.sessionId}`, sessionId: s.sessionId, deviceId: null, hostName: null, label: t("media.jobs.sessionOption", { pod: s.podId ?? s.sessionId, date: formatDisplayDateTime(s.createdAt) }) })),
    ...(pool.peerSessions ?? []).map((s) => {
      const name = s.hostName ?? t("media.pool.unnamedDevice");
      return { key: `${s.deviceId}:${s.sessionId}`, sessionId: s.sessionId, deviceId: s.deviceId, hostName: name, label: t("media.pool.peerSessionOption", { name, gpu: s.gpuTypeId ?? "GPU", date: s.startedAt ? formatDisplayDateTime(s.startedAt) : "—" }) };
    }),
  ];
  const target = targets.find((x) => x.key === chosenSessionId) ?? targets[0] ?? null;
  const runningElsewhere = openSessions.some((s) => s.status === "running" && s.channelId !== activeChannelId);
  const canRun = Boolean(activeChannelId) && target !== null && templates.length > 0;
  const recentRuns = commands.filter((c) => c.kind === "create_job").slice(0, 5);

  const severalDevices = pool.devices.length > 1;
  // A computer chosen in the filter that no longer reports falls back to every computer.
  const filter = pool.devices.some((d) => d.deviceId === deviceFilter) ? deviceFilter : ALL_DEVICES;
  const shownJobs = filter === ALL_DEVICES ? pool.jobs : pool.jobs.filter((j) => j.deviceId === filter);
  const staleDevices = pool.devices.filter((d) => d.stale);

  return (
    <Card
      title={t("media.jobs.title")}
      help={t("media.jobs.help")}
    >
      {!canRun ? (
        <p className="text-xs text-zinc-500">
          {!activeChannelId
            ? t("media.jobs.selectChannel")
            : target === null
              ? runningElsewhere
                ? t("media.jobs.runningElsewhere")
                : t("media.jobs.startSessionFirst")
              : t("media.jobs.importTemplateFirst")}
        </p>
      ) : (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            {(targets.length > 1 || target?.deviceId) && (
              <label className="block text-xs text-zinc-400 sm:col-span-2">
                {t("media.jobs.session")}
                <select value={target?.key ?? ""} onChange={(e) => setChosenSessionId(e.target.value)} className={inputClass}>
                  {targets.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
                </select>
                {target?.deviceId && <span className="mt-1 block text-zinc-500">{t("media.pool.runOnPeerNote", { name: target.hostName ?? t("media.pool.unnamedDevice") })}</span>}
              </label>
            )}
            <label className="block text-xs text-zinc-400">
              {t("media.jobs.template")}
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={inputClass}>
                <option value="">{t("media.jobs.chooseOption")}</option>
                {templates.map((tpl) => (
                  <option key={tpl.templateId} value={tpl.templateId}>
                    {tpl.name} v{tpl.version}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-zinc-400">
              {t("media.common.parametersJson")}
              {/* ui-text-ignore: a JSON format sample */}
              <textarea value={paramsText} onChange={(e) => setParamsText(e.target.value)} className={`${inputClass} h-20 font-mono text-xs`} placeholder='{"prompt": "..."}' />
            </label>
          </div>
          <button type="button" onClick={run} disabled={busy || !templateId} className={primaryButton}>
            {busy ? t("media.common.working") : t("media.jobs.run")}
          </button>
        </div>
      )}
      {recentRuns.length > 0 && (
        <div className="space-y-1 text-xs">
          <p className="text-zinc-500">{t("media.pool.recentRuns")}</p>
          {recentRuns.map((c) => (
            <CommandLine key={c.commandId} command={c} />
          ))}
        </div>
      )}

      {severalDevices && (
        <div className="flex flex-wrap items-center gap-3 border-t border-zinc-800 pt-3">
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            {t("media.pool.deviceFilter")}
            <select value={filter} onChange={(e) => setDeviceFilter(e.target.value)} className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 focus:border-zinc-500 focus:outline-none">
              <option value={ALL_DEVICES}>{t("media.pool.allDevices")}</option>
              {pool.devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {poolDeviceLabel(t, d)}
                </option>
              ))}
            </select>
          </label>
          <span className="text-xs text-zinc-500">{t("media.pool.delayNote")}</span>
        </div>
      )}
      {staleDevices.map((d) => (
        <p key={d.deviceId} className="text-xs text-amber-300">
          {t("media.pool.staleDevice", { name: poolDeviceLabel(t, d), when: d.updatedAt ? formatDisplayDateTime(d.updatedAt) : "—" })}
        </p>
      ))}

      {shownJobs.length === 0 ? (
        activeChannelId ? <p className="text-xs text-zinc-500">{t("media.pool.empty")}</p> : null
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-[760px] w-full text-left text-xs text-zinc-400">
            <thead>
              <tr className="text-zinc-500">
                <th className="py-1 pr-3">{t("media.common.colWhen")}</th>
                {severalDevices && <th className="py-1 pr-3">{t("media.pool.colDevice")}</th>}
                <th className="py-1 pr-3">{t("media.common.colStatus")}</th>
                <th className="py-1 pr-3">{t("media.pool.colWhat")}</th>
                <th className="py-1 pr-3">{t("media.common.colBy")}</th>
                <th className="py-1 pr-3">{t("media.jobs.colPlan")}</th>
                <th className="py-1 pr-3">{t("media.jobs.colOutputs")}</th>
                <th className="py-1 pr-3">{t("media.jobs.colNotes")}</th>
                <th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {shownJobs.map((j) => (
                <tr key={`${j.source}:${j.jobId}`} className="border-t border-zinc-800 align-top">
                  <td className="py-1 pr-3 whitespace-nowrap">{formatDisplayDateTime(j.createdAt)}</td>
                  {severalDevices && (
                    <td className={`py-1 pr-3 whitespace-nowrap ${j.own ? "text-zinc-300" : "text-sky-300"}`}>
                      {poolDeviceLabel(t, { hostName: j.hostName, own: j.own })}
                    </td>
                  )}
                  <td className="py-1 pr-3">
                    {mediaStatusLabel(t, j.status)}
                    {j.liveProgress ? <JobProgress progress={j.liveProgress} /> : j.progress ? <JobProgress progress={fromSharedProgress(j.progress)} /> : null}
                  </td>
                  <td className="py-1 pr-3">
                    <span className="mr-1 rounded bg-zinc-800 px-1 text-[10px] uppercase text-zinc-400">{t(j.source === "gemini" ? "media.pool.sourceGemini" : "media.pool.sourceRunpod")}</span>
                    <span className="text-zinc-300">{j.label}</span>
                    {j.costUsd !== null && (
                      <span className="block text-zinc-500">{t(j.costIsEstimate ? "media.pool.costEstimate" : "media.pool.cost", { usd: j.costUsd.toFixed(2) })}</span>
                    )}
                  </td>
                  <td className="py-1 pr-3">{j.createdBy}</td>
                  {/* BL-162 (AC-UX-11): which plan attempt the job is, instead of ids alone. */}
                  <td className="py-1 pr-3">
                    {j.plan ? (
                      <>
                        <span className="font-mono text-zinc-300">{j.plan.planId}</span>
                        {j.plan.itemKey ? <span className="font-mono"> · {j.plan.itemKey}</span> : null}
                        {j.plan.seed !== null ? <span className="text-zinc-500"> · {t("media.jobs.planSeed", { seed: String(j.plan.seed) })}</span> : null}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="py-1 pr-3 font-mono" title={`${j.jobId}${j.outputs.length > 0 ? `\n${j.outputs.map((o) => o.path).join("\n")}` : ""}`}>
                    {j.outputs.length === 0 && j.pendingOutputs === 0 ? (
                      "—"
                    ) : (
                      <>
                        {j.outputs.map((o) => (
                          <span key={o.path} className="block">
                            {o.name}
                            {!o.available && <span className="font-sans text-amber-300"> ({t("media.pool.fileNotHereYet", { name: poolDeviceLabel(t, { hostName: j.hostName, own: false }) })})</span>}
                          </span>
                        ))}
                        {j.pendingOutputs > 0 && <span className="block font-sans text-zinc-500">{t("media.pool.outputsPending", { count: j.pendingOutputs })}</span>}
                      </>
                    )}
                  </td>
                  <td className="py-1 pr-3">
                    {(() => {
                      const sent = commands.find((c) => c.kind === "cancel_job" && c.jobId === j.jobId && c.source === j.source);
                      return sent ? <CommandLine command={sent} /> : null;
                    })()}
                    {j.source === "gemini" && (j.status === "submitting" || j.status === "running") && <span className="block text-zinc-500">{t("media.pool.geminiTooLate")}</span>}
                    {j.own ? (j.error ?? "") : j.status === "failed" ? (
                      <span>
                        {t("media.pool.failedElsewhere", { name: poolDeviceLabel(t, { hostName: j.hostName, own: false }) })}
                        {j.errorCode && <span className="block font-mono text-zinc-500">{j.errorCode}</span>}
                      </span>
                    ) : (
                      ""
                    )}
                  </td>
                  <td className="py-1">
                    {poolJobCancellable(j) && !commands.some((c) => c.kind === "cancel_job" && c.jobId === j.jobId && c.source === j.source && commandPending(c)) && (
                      <button type="button" onClick={() => cancel(j)} disabled={busy} className={secondaryButton}>
                        {t("common.cancel")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pool.jobs.length >= POOL_LIST_LIMIT && <p className="mt-1 text-xs text-zinc-500">{t("media.pool.newestOnly", { count: POOL_LIST_LIMIT })}</p>}
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

/** BL-188: how many of the newest jobs Media's list shows (every computer's, after the channel and kind filter). */
const POOL_LIST_LIMIT = 50;

/**
 * The exchange janitor (Phase 14 slice 3), run by hand here (dry run first) and daily by the server. BL-162 (AC-UX-11): it is
 * this computer's maintenance, not a channel's work -- moved from Media → Jobs to Servers → Setup.
 */
export function ExchangeCleanupCard() {
  const { t } = useUiText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [janitorReport, setJanitorReport] = useState<string | null>(null);
  const [confirmJanitor, setConfirmJanitor] = useState(false);

  async function janitor(dryRun: boolean) {
    setConfirmJanitor(false);
    setBusy(true);
    setError(null);
    try {
      const report = await requestJson<{ dryRun: boolean; scanned: number; deleted: string[]; wouldDelete: string[]; kept: Array<{ key: string; reason: string }> }>("/api/media-generation/exchange/janitor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      setJanitorReport(
        dryRun
          ? t("media.jobs.janitorDryRun", { count: report.wouldDelete.length, scanned: report.scanned, kept: report.kept.length })
          : t("media.jobs.janitorDeleted", { count: report.deleted.length, scanned: report.scanned, kept: report.kept.length })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.jobs.janitorFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t("media.cleanup.title")} help={t("media.cleanup.help")}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => janitor(true)} disabled={busy} className={secondaryButton}>
          {t("media.jobs.janitorDryRunButton")}
        </button>
        <button type="button" onClick={() => setConfirmJanitor(true)} disabled={busy} className={dangerButton}>
          {t("media.jobs.janitorDeleteButton")}
        </button>
        {janitorReport && <span className="text-xs text-zinc-400">{janitorReport}</span>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {confirmJanitor && (
        <ConfirmDialog
          title={t("media.jobs.janitorConfirmTitle")}
          description={t("media.jobs.janitorConfirmDescription")}
          confirmLabel={t("media.jobs.janitorConfirmLabel")}
          confirmVariant="danger"
          onCancel={() => setConfirmJanitor(false)}
          onConfirm={() => janitor(false)}
        />
      )}
    </Card>
  );
}

type Session = MediaSession;
type SessionLimits = MediaSessionLimits;

const OPEN_STATUSES = new Set(["pending", "approved", "starting", "running", "stopping"]);
/** BL-157 (AC-SM-06): a session that is getting a pod or generating -- what Media's "now running" line shows. */
const GENERATING_STATUSES = new Set(["approved", "starting", "running"]);
const TRANSITIONAL_STATUSES = new Set(["approved", "starting", "stopping"]);
/** Poll fast while a pod is being created or terminated, slower otherwise (an agent's new request still shows up). */
const SESSIONS_FAST_POLL_MS = 5_000;
const SESSIONS_SLOW_POLL_MS = 15_000;

function minutesLabel(t: Translate, seconds: number | null): string {
  if (seconds === null) return "—";
  return t("media.duration.minutesSeconds", { m: Math.floor(seconds / 60), s: seconds % 60 });
}

function sinceLabel(t: Translate, iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  return seconds < 60 ? t("unit.seconds", { value: seconds }) : t("unit.minutes", { value: Math.floor(seconds / 60) });
}

/** What a row's status means right now, in the operator's words (the start runs in the background since slice 6). */
function statusDetail(t: Translate, s: Session, nowMs: number): string {
  switch (s.status) {
    case "pending":
      return t("media.sessions.detailPending");
    case "approved":
      return t("media.sessions.detailApproved", { since: sinceLabel(t, s.approvedAt, nowMs) });
    case "waiting_capacity":
      // BL-133: no GPU could be placed yet -- no pod, nothing billed; retried until the wait ends.
      return t("media.sessions.detailWaitingCapacity", {
        count: s.capacity?.attempts ?? 0,
        giveUp: s.capacity?.waitUntil ? t("media.sessions.detailGivesUp", { date: formatDisplayDateTime(s.capacity.waitUntil) }) : "",
      });
    case "starting":
      return t("media.sessions.detailStarting", { since: sinceLabel(t, s.startedAt, nowMs) });
    case "running":
      return s.lastActivityAt ? t("media.sessions.detailReadyActive", { since: sinceLabel(t, s.lastActivityAt, nowMs) }) : t("media.sessions.detailReady");
    case "stopping":
      return t("media.sessions.detailStopping");
    default:
      return "";
  }
}

const statusTone: Record<string, string> = {
  pending: "text-amber-300",
  approved: "text-sky-300",
  waiting_capacity: "text-amber-400",
  starting: "text-sky-300",
  running: "text-emerald-400",
  stopping: "text-orange-300",
  done: "text-zinc-400",
  failed: "text-red-400",
  rejected: "text-zinc-500",
  interrupted: "text-orange-400",
};

// Phase 14 slice 6 (owner, Telegram 2026-10-05, msgs 1549/1551/1553; PHASE_14_PLAN.md §5.2): several sessions -- each
// its own pod -- may be requested (by agents through MCP, or here) and run at once, up to the limit set in Setup. They
// are listed in one table with live statuses and per-row Approve / Reject / Stop. Approving answers at once; the pod
// start runs in the background and the row's status tells the rest -- no blocking pop-up. Every action that spends or
// ends a pod asks for a confirmation IN the row (no modal, no native dialog).
/**
 * BL-144: a running session's current job and how many wait behind it, from ComfyUI's own reports where available: the
 * job whose progress says it is running (or just finished/failed) is current; other submitted/generating jobs of the
 * session are waiting in ComfyUI's queue (the app marks every submitted job "generating" after its first poll, so the
 * status alone cannot tell). Without progress, the oldest transferring/generating/submitted job is shown as current.
 */
export function nowRunningOn(sessionId: string, jobs: MediaJob[]): { current: MediaJob | null; waiting: number } {
  const mine = jobs.filter((j) => j.sessionId === sessionId);
  const byAge = (a: MediaJob, b: MediaJob) => Date.parse(a.createdAt) - Date.parse(b.createdAt);
  const inComfy = mine.filter((j) => j.status === "submitted" || j.status === "generating").sort(byAge);
  const reportedActive = inComfy.find((j) => j.progress && ["running", "finished", "error", "interrupted"].includes(j.progress.state)) ?? null;
  const transferring = mine.filter((j) => j.status === "transferring").sort(byAge)[0] ?? null;
  const current = reportedActive ?? transferring ?? inComfy[0] ?? null;
  const waiting = mine.filter((j) => j.status === "queued").length + inComfy.filter((j) => j.jobId !== current?.jobId).length;
  return { current, waiting };
}

export function SessionsCard({ ready, activeChannelId, onLimits }: { ready: boolean; activeChannelId: string | null; onLimits?: (limits: SessionLimits) => void }) {
  const { t, usd } = useMediaText();
  // BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-05): Servers lists every channel's sessions, each named, with a channel filter.
  const { nameOf } = useChannelNames();
  const [channelFilter, setChannelFilter] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [limits, setLimits] = useState<SessionLimits | null>(null);
  const [maxMinutesText, setMaxMinutesText] = useState<string>("");
  const [maxUsd, setMaxUsd] = useState<string>("");
  // BL-135: on by default -- a session you request stops by itself a minute after its last job.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ sessionId: string; action: "approve" | "stop" } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const fetchAll = useCallback(
    () =>
      requestJson<{ sessions: Session[]; limits: SessionLimits }>("/api/media-generation/sessions").then(
        (data) => {
          setSessions(data.sessions);
          setLimits(data.limits);
          setNowMs(Date.now());
          onLimits?.(data.limits);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : t("media.sessions.loadFailed"))
      ),
    [onLimits, t]
  );

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const openSessions = limits?.openSessions ?? [];
  const fast = openSessions.some((s) => TRANSITIONAL_STATUSES.has(s.status));
  useEffect(() => {
    const timer = setInterval(() => void fetchAll(), fast ? SESSIONS_FAST_POLL_MS : SESSIONS_SLOW_POLL_MS);
    return () => clearInterval(timer);
  }, [fast, fetchAll]);

  // BL-144: what each running pod is doing right now -- its current job with ComfyUI's live progress, and how many
  // jobs wait behind it. Read only while a session runs.
  // Polled per running session (its own jobs only); every 2 s while one of them is in flight, otherwise every 15 s.
  const runningIds = openSessions.filter((s) => s.status === "running").map((s) => s.sessionId).sort().join(",");
  const [liveJobs, setLiveJobs] = useState<MediaJob[]>([]);
  const [templateNames, setTemplateNames] = useState<Map<string, string>>(new Map());
  const jobsInFlight = liveJobs.some((j) => !["done", "failed", "cancelled"].includes(j.status));
  useEffect(() => {
    if (!runningIds) return;
    let cancelled = false;
    const load = () =>
      Promise.all(
        runningIds.split(",").map((sessionId) => requestJson<{ jobs: MediaJob[] }>(`/api/media-generation/jobs?sessionId=${encodeURIComponent(sessionId)}`).then((j) => j.jobs))
      ).then(
        (lists) => {
          if (!cancelled) setLiveJobs(lists.flat());
        },
        () => {
          // Non-fatal: the block keeps its last state.
        }
      );
    void load();
    const timer = setInterval(() => void load(), jobsInFlight ? 2_000 : 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runningIds, jobsInFlight]);
  // Template names for the "Now" line; fetched again when a job names a template not seen yet.
  const missingTemplate = liveJobs.some((j) => !templateNames.has(j.templateId));
  useEffect(() => {
    if (!runningIds || !missingTemplate) return;
    let cancelled = false;
    requestJson<{ templates: WorkflowTemplate[] }>("/api/media-generation/workflow-templates").then(
      (list) => {
        if (!cancelled) setTemplateNames(new Map(list.templates.map((x) => [x.templateId, `${x.name} v${x.version}`])));
      },
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [runningIds, missingTemplate]);

  async function request() {
    if (!activeChannelId) return;
    const parsedMaxUsd = maxUsd.trim() ? parseMoney(maxUsd) : null;
    if (maxUsd.trim() && parsedMaxUsd === null) {
      setError(t("media.sessions.maxUsdInvalid"));
      return;
    }
    const maxMinutes = maxMinutesText.trim() ? parseInteger(maxMinutesText, { min: 1, max: 1440 }) : null;
    if (maxMinutesText.trim() && maxMinutes === null) {
      setError(t("media.sessions.maxMinutesInvalid"));
      return;
    }
    setRequesting(true);
    setError(null);
    try {
      await requestJson("/api/media-generation/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: activeChannelId,
          ...(maxMinutes ? { maxMinutes } : {}),
          ...(maxUsd.trim() ? { maxUsd: parsedMaxUsd } : {}),
          // releaseWhenDone is not sent: the server applies the owner's setting in Servers → Setup (msgs 1807/1810).
        }),
      });
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.sessions.requestFailed"));
    } finally {
      setRequesting(false);
    }
  }

  async function act(target: Session, action: "approve" | "reject" | "stop") {
    setConfirming(null);
    setBusyId(target.sessionId);
    setError(null);
    try {
      const body = action === "reject" ? { reason: "rejected by operator" } : action === "stop" ? { reason: "stopped by operator" } : undefined;
      await requestJson(`/api/media-generation/sessions/${encodeURIComponent(target.sessionId)}/${action}`, {
        method: "POST",
        ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t(action === "approve" ? "media.sessions.approveFailed" : action === "reject" ? "media.sessions.rejectFailed" : "media.sessions.stopFailed"));
    } finally {
      setBusyId(null);
      await fetchAll();
    }
  }

  const activeCount = limits?.activeSessionCount ?? 0;
  const maxConcurrent = limits?.maxConcurrentSessions ?? 1;
  const atLimit = activeCount >= maxConcurrent;
  const sessionChannels = [...new Set([...openSessions.map((s) => s.channelId), ...sessions.map((s) => s.channelId)])];
  // A filter on a channel that no longer has sessions here falls back to all channels (review round 2: its bar is gone).
  const shownFilter = channelFilter !== null && sessionChannels.includes(channelFilter) ? channelFilter : null;
  const ofFilter = <T extends { channelId: string }>(list: T[]) => (shownFilter === null ? list : list.filter((s) => s.channelId === shownFilter));
  const shownOpen = ofFilter(openSessions);
  const recent = ofFilter(sessions.filter((s) => !OPEN_STATUSES.has(s.status))).slice(0, 10);

  function actions(s: Session) {
    const busy = busyId === s.sessionId;
    if (confirming?.sessionId === s.sessionId) {
      const approve = confirming.action === "approve";
      return (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-300">{approve ? t("media.sessions.confirmStartText", { usd: usd(s.estimateUsd), minutes: s.maxMinutes }) : t("media.sessions.confirmStopText")}</span>
          <button type="button" onClick={() => act(s, confirming.action)} disabled={busy} className={approve ? primaryButton : dangerButton}>
            {approve ? t("media.sessions.confirmStart") : t("media.sessions.confirmStop")}
          </button>
          <button type="button" onClick={() => setConfirming(null)} className={secondaryButton}>
            {t("common.cancel")}
          </button>
        </div>
      );
    }
    if (s.status === "pending") {
      return (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setConfirming({ sessionId: s.sessionId, action: "approve" })}
            disabled={busy || !ready || atLimit}
            title={atLimit ? t("media.sessions.atLimit", { active: activeCount, max: maxConcurrent }) : undefined}
            className={primaryButton}
          >
            {t("media.sessions.approve")}
          </button>
          <button type="button" onClick={() => act(s, "reject")} disabled={busy} className={secondaryButton}>
            {t("media.sessions.reject")}
          </button>
        </div>
      );
    }
    // An `approved` row with no error is still inside createPod in the background: the server refuses a Stop then (it would
    // orphan the pod), so none is offered until the pod exists or the start has reported a problem on the row.
    // After 15 min (start + stop budgets) the start is abandoned by age and the server accepts a Stop again.
    if (s.status === "approved" && !s.error && nowMs - Date.parse(s.approvedAt ?? s.createdAt) < 15 * 60_000) return <span className="text-zinc-500">{t("media.sessions.starting")}</span>;
    return (
      <button type="button" onClick={() => setConfirming({ sessionId: s.sessionId, action: "stop" })} disabled={busy} className={dangerButton}>
        {t("media.sessions.stop")}
      </button>
    );
  }

  return (
    <Card
      title={t("media.sessions.title")}
      help={t("media.sessions.help")}
    >
      {limits && (
        <p className="text-xs text-zinc-500">
          {t("media.sessions.limitsLine", { active: activeCount, max: maxConcurrent, spent: usd(limits.accountSpentTodayUsd ?? limits.spentTodayUsd), cap: usd(limits.maxUsdPerDay), idle: limits.idleMinutes })}
        </p>
      )}

      {sessionChannels.length > 1 && (
        <div className="inline-flex flex-wrap gap-1 rounded-lg bg-zinc-950 p-1" role="tablist" aria-label={t("media.sessions.channelFilter")}>
          {[null, ...sessionChannels].map((channelId) => (
            <button
              key={channelId ?? "all"}
              type="button"
              role="tab"
              aria-selected={shownFilter === channelId}
              onClick={() => setChannelFilter(channelId)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${shownFilter === channelId ? "bg-zinc-700 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
            >
              {/* ui-text-ignore: a channel's own name (data) */}
              {channelId === null ? t("media.sessions.allChannels") : nameOf(channelId)}
            </button>
          ))}
        </div>
      )}

      {shownOpen.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs text-zinc-400">
            <thead>
              <tr className="text-zinc-500">
                <th className="py-1 pr-3">{t("media.sessions.colRequested")}</th>
                <th className="py-1 pr-3">{t("media.common.colChannel")}</th>
                <th className="py-1 pr-3">{t("media.common.colStatus")}</th>
                <th className="py-1 pr-3">{t("media.sessions.colByReason")}</th>
                <th className="py-1 pr-3">{t("media.sessions.colCaps")}</th>
                <th className="py-1 pr-3">{t("media.common.colPod")}</th>
                <th className="py-1 pr-3">{t("media.sessions.colCostSoFar")}</th>
                <th className="py-1">{t("media.sessions.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {shownOpen.map((s) => (
                <tr key={s.sessionId} className="border-t border-zinc-800 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">{formatDisplayDateTime(s.createdAt)}</td>
                  <td className="py-2 pr-3">
                    {nameOf(s.channelId)}
                    {s.channelId === activeChannelId && <div className="text-zinc-500">{t("media.sessions.thisChannel")}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <span className={`font-medium ${statusTone[s.status] ?? ""}`}>{mediaStatusLabel(t, s.status)}</span>
                    <div className="text-zinc-500">{statusDetail(t, s, nowMs)}</div>
                    {s.error && <div className="text-amber-400">{s.error}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    {s.requestedBy === "factory" ? t("media.actor.factory") : s.requestedBy}
                    {s.approvedBy === "factory" ? <div className="text-sky-300">{t("media.sessions.approvedByFactory")}</div> : null}
                    {s.reason ? <div className="text-zinc-500">{s.reason}</div> : null}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {t("unit.minutes", { value: s.maxMinutes })}
                    {s.maxUsd !== null ? ` / ${t("unit.usd", { value: String(s.maxUsd) })}` : ""}
                    <div className="text-zinc-500">
                      {t("media.sessions.estimate", { usd: usd(s.estimateUsd) })}
                      {s.fitsToday ? "" : t("media.sessions.overTodaysCap")}
                    </div>
                  </td>
                  <td className="py-2 pr-3 font-mono">
                    {s.podId ?? "—"}
                    {s.gpuTypeId && <div className="font-sans text-zinc-500">{s.gpuTypeId}</div>}
                    {s.costPerHr !== null && <div className="font-sans text-zinc-500">{t("unit.usdPerHour", { value: String(s.costPerHr) })}</div>}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{s.startedAt ? `${minutesLabel(t, s.secondsUsed)} ≈ ${t("unit.usd", { value: usd(s.usdCharged ?? 0) })}` : "—"}</td>
                  <td className="py-2">{actions(s)}</td>
                </tr>
              )).flatMap((row, index) => {
                // The same (filtered) list the rows came from (review round 3).
                const s = shownOpen[index];
                if (s.status !== "running") return [row];
                const now = nowRunningOn(s.sessionId, liveJobs);
                return [
                  row,
                  <tr key={`${s.sessionId}-now`} className="align-top">
                    <td colSpan={8} className="pb-3 pl-4 pr-3">
                      <div className="rounded-md border border-zinc-800 bg-zinc-950/50 px-3 py-2">
                        <span className="text-zinc-500">{t("media.sessions.now")} </span>
                        {now.current ? (
                          <>
                            <span className="text-zinc-200">{templateNames.get(now.current.templateId) ?? now.current.templateId}</span>
                            <span className="text-zinc-500">
                              {" "}
                              {t("media.sessions.nowJob", { job: now.current.jobId.slice(0, 8), status: now.current.status })}
                              {now.current.submittedAt ? t("media.sessions.nowSince", { date: formatDisplayDateTime(now.current.submittedAt) }) : ""}
                            </span>
                            {now.current.progress && <JobProgress progress={now.current.progress} />}
                          </>
                        ) : (
                          <span className="text-zinc-400">{t("media.sessions.noJobRunning")}</span>
                        )}
                        {now.waiting > 0 && <div className="mt-1 text-zinc-400">{t("media.sessions.moreWaiting", { count: now.waiting })}</div>}
                      </div>
                    </td>
                  </tr>,
                ];
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">{t("media.sessions.noneOpen")}</p>
      )}

      <div className="space-y-2 border-t border-zinc-800 pt-3">
        {!activeChannelId ? (
          <p className="text-xs text-zinc-500">{t("media.sessions.selectChannel")}</p>
        ) : !ready ? (
          <p className="text-xs text-zinc-500">{t("media.sessions.notReady")}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="block text-xs text-zinc-400">
              {t("media.sessions.maxMinutes")}
              <input type="text" inputMode="numeric" value={maxMinutesText} onChange={(e) => setMaxMinutesText(e.target.value)} className={inputClass} placeholder={t("media.sessions.maxMinutesPlaceholder", { value: limits?.defaultMaxMinutes ?? 60 })} />
            </label>
            <label className="block text-xs text-zinc-400">
              {t("media.sessions.maxUsd")}
              <input type="text" inputMode="decimal" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} className={inputClass} placeholder={t("media.sessions.maxUsdPlaceholder")} />
            </label>
            <div className="flex items-end">
              <button type="button" onClick={request} disabled={requesting} className={secondaryButton}>
                {requesting ? t("media.sessions.requesting") : t("media.sessions.request")}
              </button>
            </div>
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <div className="overflow-x-auto">
          <p className="mb-1 text-xs font-medium text-zinc-400">{t("media.sessions.recent")}</p>
          <table className="w-full min-w-[640px] text-left text-xs text-zinc-400">
            <thead>
              <tr className="text-zinc-500">
                <th className="py-1 pr-3">{t("media.common.colWhen")}</th>
                <th className="py-1 pr-3">{t("media.common.colChannel")}</th>
                <th className="py-1 pr-3">{t("media.common.colStatus")}</th>
                <th className="py-1 pr-3">{t("media.common.colBy")}</th>
                <th className="py-1 pr-3">{t("media.common.colPod")}</th>
                <th className="py-1 pr-3">{t("media.sessions.colUsed")}</th>
                <th className="py-1 pr-3">{t("media.common.colCost")}</th>
                <th className="py-1">{t("media.sessions.colReasonError")}</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((s) => (
                <tr key={s.sessionId} className="border-t border-zinc-800">
                  <td className="py-1 pr-3 whitespace-nowrap">{formatDisplayDateTime(s.createdAt)}</td>
                  <td className="py-1 pr-3">{nameOf(s.channelId)}</td>
                  <td className={`py-1 pr-3 ${statusTone[s.status] ?? ""}`}>{mediaStatusLabel(t, s.status)}</td>
                  <td className="py-1 pr-3">{s.requestedBy}</td>
                  <td className="py-1 pr-3 font-mono">{s.podId ?? "—"}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">{minutesLabel(t, s.secondsUsed)}</td>
                  <td className="py-1 pr-3">{s.usdCharged !== null ? t("unit.usd", { value: usd(s.usdCharged) }) : "—"}</td>
                  <td className="py-1">{s.error ?? s.stopReason ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

// BL-138 (owner, Telegram 2026-10-06; ADR 0028): the RunPod sessions of the owner's other devices, as each last reported them
// through the sync folder (about a minute behind), checked against RunPod's live pod list; and live session pods no device
// reports. Stop works from here too (owner, msg 1739): it terminates the pod through RunPod. BL-188 stage 2 (owner msg 2806):
// approve / reject a pending request works from here too -- sent to the owning computer, which applies its own limits.
type OtherDevicesResponse = {
  devices: Array<{
    deviceId: string;
    hostname: string | null;
    updatedAt: string;
    stale: boolean;
    sameAccount: boolean;
    spentTodayUsd: number;
    sessions: Array<SharedSessionRow & { live: "pod_running" | "pod_gone" | "no_pod_yet" | "ended" }>;
  }>;
  unknownPods: Array<{ podId: string; name: string; costPerHr: number | null; status: string }> | null;
  podsError: string | null;
};
type SharedSessionRow = {
  sessionId: string;
  channelId: string;
  status: string;
  requestedBy: string;
  gpuTypeId: string | null;
  podId: string | null;
  costPerHr: number | null;
  startedAt: string | null;
  stoppedAt: string | null;
  usdCharged: number | null;
  stopReason: string | null;
  /** BL-148: an open session's jobs and their live progress (absent from a device on an older build). */
  jobs?: SharedSessionJobs;
};

const LIVE_LABEL: Record<OtherDevicesResponse["devices"][number]["sessions"][number]["live"], UiTextKey> = {
  pod_running: "media.devices.livePodRunning",
  pod_gone: "media.devices.livePodGone",
  no_pod_yet: "media.devices.liveNoPodYet",
  ended: "media.devices.liveEnded",
};

/** Active elsewhere = a peer's session with a running pod (like this device's own count, a pending request is not active). */
export function countActiveElsewhere(view: Pick<OtherDevicesResponse, "devices">): number {
  return view.devices.reduce((sum, d) => sum + d.sessions.filter((s) => s.live === "pod_running").length, 0);
}

/** BL-148 (owner msg 1976): the jobs of another device's open session, with their live progress as that device last reported it. */
function PeerSessionJobsRow({ jobs, nowMs }: { jobs: SharedSessionJobs; nowMs: number }) {
  const { t } = useUiText();
  return (
    <tr>
      <td colSpan={7} className="pb-2 pl-3">
        <p className="text-zinc-400">{t("media.devices.jobs", { counts: describeSessionJobCounts(t, jobs) })}</p>
        {jobs.current.map((j) => (
          <div key={j.jobId} className="mt-1 flex flex-wrap items-start gap-x-3">
            <span className="font-mono text-zinc-300">{j.templateId}</span>
            {j.planItemKey && <span className="text-zinc-500">{t("media.devices.planItem", { item: j.planItemKey })}</span>}
            <span className="text-zinc-500">{mediaStatusLabel(t, j.status)}</span>
            {j.progress ? (
              <div>
                <JobProgress progress={fromSharedProgress(j.progress)} />
                <div className="text-zinc-600">{t("media.devices.asOf", { since: sinceLabel(t, j.progress.updatedAt, nowMs) })}</div>
              </div>
            ) : (
              j.status !== "queued" && <span className="text-zinc-600">{t("media.devices.noLiveProgress")}</span>
            )}
          </div>
        ))}
      </td>
    </tr>
  );
}

export function OtherDevicesCard({ ready, onActiveElsewhere }: { ready: boolean; onActiveElsewhere?: (count: number) => void }) {
  const { t, usd } = useMediaText();
  const { nameOf } = useChannelNames();
  const [view, setView] = useState<OtherDevicesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [stopTarget, setStopTarget] = useState<{ deviceId: string; hostname: string | null; sessionId: string; channelId: string } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [commands, setCommands] = useState<CommandView[]>([]);
  const [decideTarget, setDecideTarget] = useState<{ kind: "approve_session" | "reject_session"; deviceId: string; hostname: string | null; sessionId: string; channelId: string } | null>(null);

  async function decide() {
    const target = decideTarget;
    if (!target) return;
    setDecideTarget(null);
    setStopping(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/media-jobs/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: target.kind, targetDeviceId: target.deviceId, sessionId: target.sessionId }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.pool.commandFailed"));
    } finally {
      setStopping(false);
    }
  }

  async function stop() {
    const target = stopTarget;
    if (!target) return;
    setStopTarget(null);
    setStopping(true);
    setError(null);
    setNotice(null);
    try {
      const result = await requestJson<{ podId: string; alreadyGone: boolean; confirmed: boolean }>("/api/media-generation/sessions/devices/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceId: target.deviceId, sessionId: target.sessionId }),
      });
      setNotice(
        result.alreadyGone
          ? t("media.devices.podAlreadyGone", { pod: result.podId })
          : result.confirmed
            ? t("media.devices.podTerminated", { pod: result.podId, device: target.hostname ?? t("media.devices.thatDevice") })
            : t("media.devices.terminateSent", { pod: result.podId })
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.devices.stopFailed"));
    } finally {
      setStopping(false);
    }
  }

  const load = useCallback(
    () =>
      Promise.all([
        requestJson<OtherDevicesResponse>("/api/media-generation/sessions/devices").then(
          (data) => {
            setView(data);
            setError(null);
            setNowMs(Date.now());
            onActiveElsewhere?.(countActiveElsewhere(data));
          },
          (err: unknown) => setError(err instanceof Error ? err.message : t("media.devices.loadFailed"))
        ),
        // BL-188 stage 2: the approve / reject actions sent from here, with the other computers' answers.
        requestJson<{ commands: CommandView[] }>("/api/media-jobs/commands").then(
          (data) => setCommands(data.commands.filter((c) => c.kind === "approve_session" || c.kind === "reject_session")),
          () => undefined
        ),
      ]).then(() => undefined),
    [onActiveElsewhere, t]
  );

  useEffect(() => {
    if (!ready) return;
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [ready, load]);

  if (!ready) return null;
  const devices = view?.devices ?? [];
  return (
    <Card
      title={t("media.devices.title")}
      help={t("media.devices.help")}
    >
      {error && <p className="text-xs text-red-400">{error}</p>}
      {view?.podsError && <p className="text-xs text-amber-400">{t("media.devices.podsError", { error: view.podsError })}</p>}
      {view && devices.length === 0 && <p className="text-xs text-zinc-500">{t("media.devices.none")}</p>}
      {devices.map((d) => (
        <div key={d.deviceId} className="space-y-1">
          <p className="text-xs text-zinc-300">
            <span className="font-medium text-zinc-100">{d.hostname ?? d.deviceId}</span>
            {t("media.devices.reportLine", { since: sinceLabel(t, d.updatedAt, nowMs), usd: usd(d.spentTodayUsd) })}
            {d.stale && <span className="text-amber-400">{t("media.devices.stale")}</span>}
            {!d.sameAccount && <span className="text-zinc-500">{t("media.devices.otherAccount")}</span>}
          </p>
          {d.sessions.length === 0 ? (
            <p className="text-xs text-zinc-500">{t("media.devices.noSessions")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs text-zinc-400">
                <thead>
                  <tr className="text-zinc-500">
                    <th className="py-1 pr-3">{t("media.common.colStatus")}</th>
                    {/* ui-text-ignore: product name as a column header */}
                    <th className="py-1 pr-3">RunPod</th>
                    <th className="py-1 pr-3">{t("media.common.colChannel")}</th>
                    {/* ui-text-ignore: the hardware acronym, the same in every language */}
                    <th className="py-1 pr-3">GPU</th>
                    <th className="py-1 pr-3">{t("media.devices.colStarted")}</th>
                    <th className="py-1 pr-3">{t("media.common.colCost")}</th>
                    <th className="py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {d.sessions.map((s) => (
                    <Fragment key={s.sessionId}>
                    <tr className="border-t border-zinc-800">
                      <td className="py-1 pr-3 text-zinc-200">{mediaStatusLabel(t, s.status)}</td>
                      <td className={`py-1 pr-3 ${s.live === "pod_gone" ? "text-amber-400" : ""}`}>{t(LIVE_LABEL[s.live])}</td>
                      <td className="py-1 pr-3">{nameOf(s.channelId)}</td>
                      <td className="py-1 pr-3">{s.gpuTypeId ?? "—"}</td>
                      <td className="py-1 pr-3">{s.startedAt ? formatDisplayDateTime(s.startedAt) : "—"}</td>
                      <td className="py-1 pr-3">{s.usdCharged !== null ? t("unit.usd", { value: usd(s.usdCharged) }) : "—"}</td>
                      <td className="py-1 text-right">
                        {s.status === "pending" && !commands.some((c) => c.sessionId === s.sessionId && c.targetDeviceId === d.deviceId && commandPending(c)) && (
                          <span className="inline-flex gap-2">
                            <button type="button" onClick={() => setDecideTarget({ kind: "approve_session", deviceId: d.deviceId, hostname: d.hostname, sessionId: s.sessionId, channelId: s.channelId })} disabled={stopping} className={primaryButton}>
                              {t("media.sessions.approve")}
                            </button>
                            <button type="button" onClick={() => setDecideTarget({ kind: "reject_session", deviceId: d.deviceId, hostname: d.hostname, sessionId: s.sessionId, channelId: s.channelId })} disabled={stopping} className={secondaryButton}>
                              {t("media.sessions.reject")}
                            </button>
                          </span>
                        )}
                        {s.live === "pod_running" && d.sameAccount && (
                          <button
                            type="button"
                            onClick={() => setStopTarget({ deviceId: d.deviceId, hostname: d.hostname, sessionId: s.sessionId, channelId: s.channelId })}
                            disabled={stopping}
                            className={dangerButton}
                          >
                            {t("media.sessions.stop")}
                          </button>
                        )}
                      </td>
                    </tr>
                    {(() => {
                      const sent = commands.find((c) => c.sessionId === s.sessionId && c.targetDeviceId === d.deviceId);
                      return sent ? (
                        <tr>
                          <td colSpan={7} className="pb-1 pl-3 text-xs">
                            <CommandLine command={sent} />
                          </td>
                        </tr>
                      ) : null;
                    })()}
                    {s.jobs && <PeerSessionJobsRow jobs={s.jobs} nowMs={nowMs} />}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {stopTarget && (
        <ConfirmDialog
          title={t("media.devices.stopTitle", { device: stopTarget.hostname ?? stopTarget.deviceId })}
          description={t("media.devices.stopDescription", { channel: nameOf(stopTarget.channelId), device: stopTarget.hostname ?? t("media.devices.thatDevice") })}
          confirmLabel={t("media.devices.stopConfirm")}
          confirmVariant="danger"
          onCancel={() => setStopTarget(null)}
          onConfirm={stop}
        />
      )}
      {decideTarget && (
        <ConfirmDialog
          title={t(decideTarget.kind === "approve_session" ? "media.devices.approveTitle" : "media.devices.rejectTitle", { device: decideTarget.hostname ?? t("media.devices.thatDevice") })}
          description={t(decideTarget.kind === "approve_session" ? "media.devices.approveDescription" : "media.devices.rejectDescription", { channel: nameOf(decideTarget.channelId), device: decideTarget.hostname ?? t("media.devices.thatDevice") })}
          confirmLabel={t(decideTarget.kind === "approve_session" ? "media.sessions.approve" : "media.sessions.reject")}
          confirmVariant={decideTarget.kind === "approve_session" ? "default" : "danger"}
          onCancel={() => setDecideTarget(null)}
          onConfirm={decide}
        />
      )}
      {view?.unknownPods && view.unknownPods.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-amber-400">{t("media.devices.unknownPods")}</p>
          <ul className="text-xs text-zinc-300">
            {view.unknownPods.map((p) => (
              <li key={p.podId}>
                {p.name} · {p.podId} · {podStatusLabel(t, p.status)}
                {p.costPerHr !== null ? ` · ${t("unit.usdPerHour", { value: usd(p.costPerHr) })}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function ReadinessBanner({ overview }: { overview: Overview }) {
  const { t } = useUiText();
  if (overview.ready) return <p className="text-xs text-emerald-400">{t("media.readiness.ready")}</p>;
  return <p className="text-xs text-zinc-500">{t("media.readiness.missing", { missing: overview.missing.join(", ") })}</p>;
}

export function CredentialsCard({ status, onChanged }: { status: CredentialsStatus; onChanged: () => Promise<void> }) {
  const { t } = useUiText();
  const [editing, setEditing] = useState(!status.configured);
  const [runpodApiKey, setRunpodApiKey] = useState("");
  const [s3AccessKeyId, setS3AccessKeyId] = useState("");
  const [s3SecretAccessKey, setS3SecretAccessKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!status.configured) setEditing(true);
  }, [status.configured]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/media-generation/credentials", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runpodApiKey,
          s3AccessKeyId: s3AccessKeyId.trim() || null,
          s3SecretAccessKey: s3SecretAccessKey.trim() || null,
        }),
      });
      setRunpodApiKey("");
      setS3AccessKeyId("");
      setS3SecretAccessKey("");
      setEditing(false);
      setTestResult(null);
      setNotice(t("media.credentials.saved"));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.common.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setTestResult(await requestJson<TestResult>("/api/media-generation/credentials/test", { method: "POST" }));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.credentials.testFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setConfirmClear(false);
    setBusy(true);
    setError(null);
    try {
      await requestJson("/api/media-generation/credentials", { method: "DELETE" });
      setTestResult(null);
      setNotice(t("media.credentials.removed"));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.credentials.clearFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={t("media.credentials.title")}
      help={t("media.credentials.help")}
    >
      {!status.configured && status.reason === "key_file_missing" && (
        <p className="text-xs text-amber-400">{t("media.credentials.keyFileMissing")}</p>
      )}
      {!status.configured && status.reason === "key_file_invalid" && (
        <div className="space-y-2">
          <p className="text-xs text-red-400">{t("media.credentials.keyFileInvalid")}</p>
          <button type="button" onClick={() => setConfirmClear(true)} disabled={busy} className={dangerButton}>
            {t("media.credentials.reset")}
          </button>
        </div>
      )}

      {status.configured && !editing && (
        <div className="space-y-2">
          <p className="text-sm text-zinc-300">
            {t("media.credentials.runpodKey")} <span className="font-mono text-zinc-100">{status.runpodKeyPrefix}</span>
            {status.s3AccessKeyId ? (
              <>
                {" · "}
                {t("media.credentials.s3Key")} <span className="font-mono text-zinc-100">{status.s3AccessKeyId}</span>
              </>
            ) : (
              <span className="text-zinc-500">{t("media.credentials.noS3")}</span>
            )}
          </p>
          <p className="text-xs text-zinc-500">
            {t("media.credentials.savedAt", { date: formatDisplayDateTime(status.updatedAt) })}
            {status.verifiedAt ? t("media.credentials.lastVerified", { date: formatDisplayDateTime(status.verifiedAt) }) : t("media.credentials.notVerified")}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={test} disabled={busy} className={primaryButton}>
              {busy ? t("media.common.working") : t("media.credentials.test")}
            </button>
            <button type="button" onClick={() => setEditing(true)} disabled={busy} className={secondaryButton}>
              {t("media.credentials.replace")}
            </button>
            <button type="button" onClick={() => setConfirmClear(true)} disabled={busy} className={dangerButton}>
              {t("media.credentials.clear")}
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="space-y-2">
          <label className="block text-xs text-zinc-400">
            {t("media.credentials.runpodApiKey")}
            <input type="password" autoComplete="off" value={runpodApiKey} onChange={(e) => setRunpodApiKey(e.target.value)} className={inputClass} placeholder="rpa_…" />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs text-zinc-400">
              {t("media.credentials.s3AccessKeyId")}
              <input type="text" autoComplete="off" value={s3AccessKeyId} onChange={(e) => setS3AccessKeyId(e.target.value)} className={inputClass} placeholder="user_…" />
            </label>
            <label className="block text-xs text-zinc-400">
              {t("media.credentials.s3Secret")}
              <input type="password" autoComplete="off" value={s3SecretAccessKey} onChange={(e) => setS3SecretAccessKey(e.target.value)} className={inputClass} placeholder="rps_…" />
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={busy || runpodApiKey.trim().length < 16} className={primaryButton}>
              {busy ? t("common.saving") : t("common.save")}
            </button>
            {status.configured && (
              <button type="button" onClick={() => setEditing(false)} disabled={busy} className={secondaryButton}>
                {t("common.cancel")}
              </button>
            )}
          </div>
        </div>
      )}

      {testResult && (
        <div className="space-y-1 text-xs">
          <p className={testResult.runpod.ok ? "text-emerald-400" : "text-red-400"}>
            {t("media.credentials.testRunpod", { result: testResult.runpod.ok ? t("media.credentials.ok") : testResult.runpod.message })}
          </p>
          <p className={"skipped" in testResult.s3 ? "text-zinc-500" : testResult.s3.ok ? "text-emerald-400" : "text-red-400"}>
            {t("media.credentials.testS3", {
              result: "skipped" in testResult.s3 ? t("media.credentials.skipped", { reason: testResult.s3.reason }) : testResult.s3.ok ? t("media.credentials.ok") : testResult.s3.message,
            })}
          </p>
        </div>
      )}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}

      {confirmClear && (
        <ConfirmDialog
          title={!status.configured && status.reason === "key_file_invalid" ? t("media.credentials.resetTitle") : t("media.credentials.removeTitle")}
          description={
            !status.configured && status.reason === "key_file_invalid"
              ? t("media.credentials.resetDescription")
              : t("media.credentials.removeDescription")
          }
          confirmLabel={t("media.credentials.remove")}
          confirmVariant="danger"
          onCancel={() => setConfirmClear(false)}
          onConfirm={clear}
        />
      )}
    </Card>
  );
}

export function ComputeCard({ overview, gatewayTraffic, onChanged }: { overview: Overview; gatewayTraffic: GatewayTrafficWindowView[] | undefined; onChanged: () => Promise<void> }) {
  const { t, usd } = useMediaText();
  const { settings, credentials } = overview;
  const [catalog, setCatalog] = useState<{ gpus: Gpu[]; dataCenters: DataCenter[] } | null>(null);
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState({ datacenterId: settings.datacenterId ?? "", gpuTypeId: settings.gpuTypeId ?? "", cloudType: settings.cloudType, templateId: settings.templateId ?? "" });

  useEffect(() => {
    setDraft({ datacenterId: settings.datacenterId ?? "", gpuTypeId: settings.gpuTypeId ?? "", cloudType: settings.cloudType, templateId: settings.templateId ?? "" });
  }, [settings.datacenterId, settings.gpuTypeId, settings.cloudType, settings.templateId]);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const [cat, tpl] = await Promise.all([
        requestJson<{ gpus: Gpu[]; dataCenters: DataCenter[] }>("/api/media-generation/catalog"),
        requestJson<{ templates: Template[] }>("/api/media-generation/templates"),
      ]);
      setCatalog(cat);
      setTemplates(tpl.templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.compute.loadFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/media-generation/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(onlyChangedSettings({
          datacenterId: draft.datacenterId || null,
          gpuTypeId: draft.gpuTypeId || null,
          cloudType: draft.cloudType,
          templateId: draft.templateId || null,
        }, overview.settings, overview.settings.gpuTypeId !== null && overview.settings.gpuOnDemandPricePerHr === null ? ["gpuTypeId"] : [])),
      });
      setNotice(t("common.saved"));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.common.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function toggleGateway(enabled: boolean) {
    setError(null);
    try {
      await requestJson("/api/media-generation/gateway", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.compute.toggleFailed"));
    }
  }

  const gpuOptions = catalog?.gpus.filter((g) => (draft.cloudType === "SECURE" ? g.secureCloud : g.communityCloud)) ?? [];
  const traffic = (category: string) => gatewayTraffic?.find((c) => c.category === category);

  return (
    <Card
      title={t("media.compute.title")}
      help={t("media.compute.help")}
    >
      <SettingsSectionRow
        left={
          <div className="flex items-center gap-3">
            <ToggleSwitch label={t("media.compute.gatewayToggle")} checked={overview.gatewayEnabled} onChange={toggleGateway} />
            <span className="text-sm text-zinc-300">{t("media.compute.gateway")}</span>
          </div>
        }
        right={
          <div>
            <GatewayTrafficStats size="lg" window={traffic("runpod_api")} />
            <p className="text-xs text-zinc-500">
              {t("media.compute.traffic", { s3: traffic("runpod_s3")?.totalAttempts ?? 0, comfy: traffic("comfyui_api")?.totalAttempts ?? 0, hf: traffic("huggingface_api")?.totalAttempts ?? 0 })}
            </p>
          </div>
        }
      />

      {!credentials.configured ? (
        <p className="text-xs text-zinc-500">{t("media.compute.noCredentials")}</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button type="button" onClick={load} disabled={busy} className={secondaryButton}>
              {busy ? t("common.loading") : catalog ? t("media.compute.reload") : t("media.compute.load")}
            </button>
            {!catalog && (settings.datacenterId || settings.gpuTypeId) && (
              <span className="text-xs text-zinc-500">
                {t("media.compute.savedLine", { dc: settings.datacenterId ?? "—", gpu: settings.gpuTypeId ?? "—", cloud: settings.cloudType, template: settings.templateId ?? "—" })}
              </span>
            )}
          </div>
          {catalog && (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-xs text-zinc-400">
                {t("setupField.cloudType")}
                <select value={draft.cloudType} onChange={(e) => setDraft({ ...draft, cloudType: e.target.value as "SECURE" | "COMMUNITY" })} className={inputClass}>
                  <option value="SECURE">{t("media.compute.secureCloud")}</option>
                  <option value="COMMUNITY">{t("media.compute.communityCloud")}</option>
                </select>
              </label>
              <label className="block text-xs text-zinc-400">
                {t("setupField.datacenterId")}
                <select value={draft.datacenterId} onChange={(e) => setDraft({ ...draft, datacenterId: e.target.value })} className={inputClass}>
                  <option value="">{t("media.common.notSetOption")}</option>
                  {catalog.dataCenters.map((dc) => (
                    <option key={dc.id} value={dc.id}>
                      {dc.id}
                      {dc.region ? ` · ${dc.region.toLowerCase().replace(/_/g, " ")}` : ""}
                      {dc.networkVolumeTypes.length > 0 ? t("media.compute.dcVolumes", { types: dc.networkVolumeTypes.join(", ").toLowerCase().replace(/_/g, " ") }) : t("media.compute.dcNoVolumes")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-zinc-400 sm:col-span-2">
                {t("setupField.gpuTypeId")}
                <select value={draft.gpuTypeId} onChange={(e) => setDraft({ ...draft, gpuTypeId: e.target.value })} className={inputClass}>
                  <option value="">{t("media.common.notSetOption")}</option>
                  {gpuOptions.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.displayName}
                      {g.memoryInGb ? ` · ${t("unit.gb", { value: g.memoryInGb })}` : ""}
                      {g.onDemandPricePerHr !== null ? ` · ${t("unit.usdPerHour", { value: usd(g.onDemandPricePerHr) })}` : ""}
                      {draft.datacenterId
                        ? (() => {
                            const here = g.dataCenters.find((dc) => dc.id === draft.datacenterId);
                            return here
                              ? t("media.compute.availableIn", { availability: here.estimatedAvailability?.toLowerCase() ?? t("media.compute.available"), dc: draft.datacenterId })
                              : t("media.compute.notAvailableIn", { dc: draft.datacenterId });
                          })()
                        : g.estimatedAvailability
                          ? t("media.compute.availability", { availability: g.estimatedAvailability.toLowerCase() })
                          : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-zinc-400 sm:col-span-2">
                {t("setupField.templateId")}
                <select value={draft.templateId} onChange={(e) => setDraft({ ...draft, templateId: e.target.value })} className={inputClass}>
                  <option value="">{t("media.common.notSetOption")}</option>
                  {(templates ?? []).map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name} ({tpl.id})
                    </option>
                  ))}
                </select>
              </label>
              <div className="sm:col-span-2">
                <button type="button" onClick={save} disabled={busy} className={primaryButton}>
                  {busy ? t("common.saving") : t("media.compute.save")}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

export function VolumeCard({ overview, onChanged }: { overview: Overview; onChanged: () => Promise<void> }) {
  const { t, usd } = useMediaText();
  const { settings, credentials } = overview;
  const [volumes, setVolumes] = useState<Volume[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState(settings.networkVolumeId ?? "");
  const [newName, setNewName] = useState("models");
  const [newSizeText, setNewSizeText] = useState("150");
  const newSize = parseInteger(newSizeText, { min: 10, max: 4000 });
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [growSizeText, setGrowSizeText] = useState("");
  const [confirmGrow, setConfirmGrow] = useState(false);
  const [deleteVolume, setDeleteVolume] = useState<Volume | null>(null);

  useEffect(() => {
    setSelected(settings.networkVolumeId ?? "");
  }, [settings.networkVolumeId]);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setVolumes((await requestJson<{ volumes: Volume[] }>("/api/media-generation/network-volumes")).volumes);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.volume.loadFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function saveSelection() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/media-generation/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(onlyChangedSettings({ networkVolumeId: selected || null }, overview.settings)),
      });
      setNotice(t("common.saved"));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.common.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setConfirmCreate(false);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { volume } = await requestJson<{ volume: Volume }>("/api/media-generation/network-volumes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newName, datacenterId: settings.datacenterId, sizeGb: newSize }),
      });
      setNotice(t("media.volume.created", { name: volume.name, id: volume.id }));
      await load();
      setSelected(volume.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.volume.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function grow() {
    if (!selectedVolume || growSize === null) return;
    setConfirmGrow(false);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { volume } = await requestJson<{ volume: Volume }>("/api/media-generation/network-volumes", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ volumeId: selectedVolume.id, sizeGb: growSize }),
      });
      setNotice(t("media.volume.resized", { name: volume.name, size: volume.sizeGb }));
      setGrowSizeText("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.volume.resizeFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function removeVolume() {
    const target = deleteVolume;
    if (!target) return;
    setDeleteVolume(null);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/media-generation/network-volumes", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ volumeId: target.id }) });
      setNotice(t("media.volume.deleted", { name: target.name, id: target.id }));
      if (selected === target.id) setSelected(settings.networkVolumeId ?? "");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.volume.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  const selectedVolume = volumes?.find((v) => v.id === selected);
  // BL-136: every volume except the one the app uses can be deleted (the server also refuses one a pod has mounted).
  const unusedVolumes = (volumes ?? []).filter((v) => v.id !== settings.networkVolumeId);
  const monthly = (sizeGb: number) => usd(sizeGb * NETWORK_VOLUME_USD_PER_GB_MONTH);
  // RunPod only grows a network volume (its API refuses a smaller size), so the field accepts current + 1 GB and up.
  const growSize = selectedVolume && selectedVolume.sizeGb < 4000 ? parseInteger(growSizeText, { min: selectedVolume.sizeGb + 1, max: 4000 }) : null;

  return (
    <Card
      title={t("setupField.networkVolumeId")}
      help={t("media.volume.help")}
    >
      {!credentials.configured ? (
        <p className="text-xs text-zinc-500">{t("media.volume.noCredentials")}</p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={load} disabled={busy} className={secondaryButton}>
              {busy ? t("common.loading") : volumes ? t("media.volume.reload") : t("media.volume.load")}
            </button>
            {!volumes && <span className="text-xs text-zinc-500">{t("media.volume.savedLine", { id: settings.networkVolumeId ?? "—" })}</span>}
          </div>
          {volumes && (
            <div className="space-y-2">
              <label className="block text-xs text-zinc-400">
                {t("media.volume.volume")}
                <select
                  value={selected}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setGrowSizeText("");
                  }}
                  className={inputClass}
                >
                  <option value="">{t("media.common.notSetOption")}</option>
                  {volumes.map((v) => (
                    <option key={v.id} value={v.id}>
                      {t("media.volume.option", { name: v.name, dc: v.dataCenterId, size: v.sizeGb, used: v.usedSizeGb !== null ? t("media.volume.usedSuffix", { used: v.usedSizeGb }) : "", usd: monthly(v.sizeGb) })}
                    </option>
                  ))}
                </select>
              </label>
              {selectedVolume && settings.datacenterId && selectedVolume.dataCenterId !== settings.datacenterId && (
                <p className="text-xs text-amber-400">
                  {t("media.volume.dcMismatch", { volumeDc: selectedVolume.dataCenterId, dc: settings.datacenterId })}
                </p>
              )}
              <button type="button" onClick={saveSelection} disabled={busy} className={primaryButton}>
                {busy ? t("common.saving") : t("media.volume.save")}
              </button>
              {selectedVolume && (
                <div className="mt-3 border-t border-zinc-800 pt-3">
                  <p className="mb-2 text-xs text-zinc-400">
                    {t("media.volume.growIntro", {
                      name: selectedVolume.name,
                      size: selectedVolume.sizeGb,
                      used: selectedVolume.usedSizeGb !== null ? t("media.volume.usedSuffix", { used: selectedVolume.usedSizeGb }) : "",
                      usd: monthly(selectedVolume.sizeGb),
                    })}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={growSizeText}
                      onChange={(e) => setGrowSizeText(e.target.value)}
                      className={inputClass}
                      placeholder={selectedVolume.sizeGb < 4000 ? t("media.volume.growPlaceholder", { min: String(selectedVolume.sizeGb + 1) }) : t("media.volume.growAtMaxPlaceholder")}
                      disabled={selectedVolume.sizeGb >= 4000}
                    />
                    <button type="button" onClick={() => setConfirmGrow(true)} disabled={busy || growSize === null} className={secondaryButton}>
                      {selectedVolume.sizeGb >= 4000
                        ? t("media.volume.growAtMax")
                        : growSize === null
                          ? t("media.volume.growButtonRange", { min: String(selectedVolume.sizeGb + 1) })
                          : t("media.volume.growButtonPrice", { usd: monthly(growSize) })}
                    </button>
                  </div>
                </div>
              )}
              {unusedVolumes.length > 0 && (
                <div className="mt-3 border-t border-zinc-800 pt-3">
                  <p className="mb-2 text-xs text-zinc-400">{t("media.volume.unused")}</p>
                  <ul className="space-y-1">
                    {unusedVolumes.map((v) => (
                      <li key={v.id} className="flex items-center justify-between gap-2 text-xs text-zinc-300">
                        <span>
                          {t("media.volume.unusedItem", { name: v.name, id: v.id, dc: v.dataCenterId, size: v.sizeGb, usd: monthly(v.sizeGb) })}
                        </span>
                        <button type="button" onClick={() => setDeleteVolume(v)} disabled={busy} className={dangerButton}>
                          {t("media.common.delete")}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-3 border-t border-zinc-800 pt-3">
                <p className="mb-2 text-xs text-zinc-400">{t("media.volume.createIn", { dc: settings.datacenterId ?? t("media.volume.chosenDc") })}</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} className={inputClass} placeholder={t("media.volume.namePlaceholder")} />
                  <input type="text" inputMode="numeric" value={newSizeText} onChange={(e) => setNewSizeText(e.target.value)} className={inputClass} placeholder="10–4000" />
                  <button type="button" onClick={() => setConfirmCreate(true)} disabled={busy || !settings.datacenterId || !newName.trim() || newSize === null} className={secondaryButton}>
                    {newSize === null ? t("media.volume.createButtonRange") : t("media.volume.createButtonPrice", { usd: monthly(newSize) })}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {confirmCreate && (
        <ConfirmDialog
          title={t("media.volume.createTitle", { size: newSize ?? 0, dc: settings.datacenterId ?? "" })}
          description={t("media.volume.createDescription", { usd: monthly(newSize ?? 0) })}
          confirmLabel={t("media.volume.createConfirm")}
          onCancel={() => setConfirmCreate(false)}
          onConfirm={create}
        />
      )}
      {deleteVolume && (
        <ConfirmDialog
          title={t("media.volume.deleteTitle", { name: deleteVolume.name, size: deleteVolume.sizeGb })}
          description={t("media.volume.deleteDescription", { id: deleteVolume.id, usd: monthly(deleteVolume.sizeGb) })}
          confirmLabel={t("media.volume.deleteConfirm")}
          onCancel={() => setDeleteVolume(null)}
          onConfirm={removeVolume}
        />
      )}
      {confirmGrow && selectedVolume && growSize !== null && (
        <ConfirmDialog
          title={t("media.volume.growTitle", { name: selectedVolume.name, from: selectedVolume.sizeGb, to: growSize })}
          description={t("media.volume.growDescription", { usd: monthly(growSize), delta: monthly(growSize - selectedVolume.sizeGb) })}
          confirmLabel={t("media.volume.growConfirm")}
          onCancel={() => setConfirmGrow(false)}
          onConfirm={grow}
        />
      )}
    </Card>
  );
}

export function LimitsCard({ settings, onChanged }: { settings: Settings; onChanged: () => Promise<void> }) {
  const { t } = useUiText();
  // Every field is a controlled text input parsed on save (parseInteger / parseMoney): never a native number widget
  // (locale-dependent, and a cleared field would silently become 0).
  const [draft, setDraft] = useState({
    defaultMaxMinutes: String(settings.defaultMaxMinutes),
    idleMinutes: String(settings.idleMinutes),
    watchIntervalSeconds: String(settings.watchIntervalSeconds),
    maxConcurrentSessions: String(settings.maxConcurrentSessions),
  });
  const [maxUsdPerDayText, setMaxUsdPerDayText] = useState(String(settings.maxUsdPerDay));
  const [ownerReleaseWhenDone, setOwnerReleaseWhenDone] = useState(settings.ownerReleaseWhenDone);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setDraft({
      defaultMaxMinutes: String(settings.defaultMaxMinutes),
      idleMinutes: String(settings.idleMinutes),
      watchIntervalSeconds: String(settings.watchIntervalSeconds),
      maxConcurrentSessions: String(settings.maxConcurrentSessions),
    });
    setMaxUsdPerDayText(String(settings.maxUsdPerDay));
    setOwnerReleaseWhenDone(settings.ownerReleaseWhenDone);
  }, [settings.maxUsdPerDay, settings.defaultMaxMinutes, settings.idleMinutes, settings.watchIntervalSeconds, settings.maxConcurrentSessions, settings.ownerReleaseWhenDone]);

  async function save() {
    const maxUsdPerDay = parseMoney(maxUsdPerDayText);
    if (maxUsdPerDay === null) {
      setError(t("media.limits.maxUsdInvalid"));
      return;
    }
    const defaultMaxMinutes = parseInteger(draft.defaultMaxMinutes, { min: 1, max: 1440 });
    const idleMinutes = parseInteger(draft.idleMinutes, { min: 1, max: 1440 });
    const watchIntervalSeconds = parseInteger(draft.watchIntervalSeconds, { min: 15, max: 3600 });
    const maxConcurrentSessions = parseInteger(draft.maxConcurrentSessions, MAX_CONCURRENT_SESSIONS_RANGE);
    if (defaultMaxMinutes === null || idleMinutes === null || watchIntervalSeconds === null || maxConcurrentSessions === null) {
      setError(t("media.limits.invalid", { min: String(MAX_CONCURRENT_SESSIONS_RANGE.min), max: String(MAX_CONCURRENT_SESSIONS_RANGE.max) }));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/media-generation/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(onlyChangedSettings({ maxUsdPerDay, defaultMaxMinutes, idleMinutes, watchIntervalSeconds, maxConcurrentSessions, ownerReleaseWhenDone }, settings)) });
      setNotice(t("common.saved"));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.common.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, key: keyof typeof draft, props: { min: number; max: number }) => (
    <label className="block text-xs text-zinc-400">
      {label} ({props.min}–{props.max})
      <input type="text" inputMode="numeric" value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} className={inputClass} />
    </label>
  );

  return (
    <Card
      title={t("media.limits.title")}
      help={t("media.limits.help")}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-zinc-400">
          {t("media.limits.maxUsdPerDay")}
          <input type="text" inputMode="decimal" value={maxUsdPerDayText} onChange={(e) => setMaxUsdPerDayText(e.target.value)} className={inputClass} placeholder={t("media.limits.maxUsdPerDayPlaceholder")} />
        </label>
        {field(t("media.limits.defaultMaxMinutes"), "defaultMaxMinutes", { min: 1, max: 1440 })}
        {field(t("media.limits.idleMinutes"), "idleMinutes", { min: 1, max: 1440 })}
        {field(t("media.limits.watchIntervalSeconds"), "watchIntervalSeconds", { min: 15, max: 3600 })}
        {field(t("media.limits.maxConcurrentSessions"), "maxConcurrentSessions", MAX_CONCURRENT_SESSIONS_RANGE)}
      </div>
      <div className="flex items-center gap-2">
        <ToggleSwitch label={t("media.limits.releaseToggle")} checked={ownerReleaseWhenDone} onChange={setOwnerReleaseWhenDone} />
        <span className="text-xs text-zinc-400">{t("media.limits.releaseExplanation")}</span>
      </div>
      <button type="button" onClick={save} disabled={busy} className={primaryButton}>
        {busy ? t("common.saving") : t("media.limits.save")}
      </button>
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

// BL-133 (docs/roadmap/plans/FACTORY_GPU_SESSIONS_PLAN.md §2.1): the owner's limits for sessions the Factory Operator starts
// itself. Within all of them (and the device limits above) a factory start is approved by the factory; otherwise it waits in
// the Sessions table for you. On by default (owner, 2026-10-06); switch it off to make every factory start wait for you.
export function FactoryLimitsCard({ settings, onChanged }: { settings: Settings; onChanged: () => Promise<void> }) {
  const { t } = useUiText();
  const initial = () => ({
    perSessionUsd: String(settings.factoryMaxUsdPerSession),
    perSessionMinutes: String(settings.factoryMaxMinutesPerSession),
    perDayUsd: String(settings.factoryMaxUsdPerDay),
    perMonthUsd: String(settings.factoryMaxUsdPerMonth),
  });
  const [draft, setDraft] = useState(initial);
  const [enabled, setEnabled] = useState(settings.factorySessionsEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setDraft(initial());
    setEnabled(settings.factorySessionsEnabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.factorySessionsEnabled, settings.factoryMaxUsdPerSession, settings.factoryMaxMinutesPerSession, settings.factoryMaxUsdPerDay, settings.factoryMaxUsdPerMonth]);

  async function save(nextEnabled = enabled) {
    const factoryMaxUsdPerSession = parseMoney(draft.perSessionUsd);
    const factoryMaxMinutesPerSession = parseInteger(draft.perSessionMinutes, { min: 1, max: 1440 });
    const factoryMaxUsdPerDay = parseMoney(draft.perDayUsd);
    const factoryMaxUsdPerMonth = parseMoney(draft.perMonthUsd);
    if (factoryMaxUsdPerSession === null || factoryMaxUsdPerDay === null || factoryMaxUsdPerMonth === null || factoryMaxMinutesPerSession === null) {
      setError(t("media.factory.invalid"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/media-generation/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(onlyChangedSettings({ factorySessionsEnabled: nextEnabled, factoryMaxUsdPerSession, factoryMaxMinutesPerSession, factoryMaxUsdPerDay, factoryMaxUsdPerMonth }, settings)),
      });
      setNotice(t("common.saved"));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.common.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, key: keyof typeof draft, mode: "decimal" | "numeric") => (
    <label className="block text-xs text-zinc-400">
      {label}
      <input type="text" inputMode={mode} value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} className={inputClass} />
    </label>
  );

  return (
    <Card
      title={t("media.factory.title")}
      help={t("media.factory.help")}
    >
      <div className="flex items-center gap-3">
        <ToggleSwitch
          label={t("media.factory.toggle")}
          checked={enabled}
          onChange={(next) => {
            setEnabled(next);
            void save(next);
          }}
          disabled={busy}
        />
        <span className="text-sm text-zinc-300">{t("media.factory.toggleText")}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {field(t("media.factory.perSessionUsd"), "perSessionUsd", "decimal")}
        {field(t("media.factory.perSessionMinutes"), "perSessionMinutes", "numeric")}
        {field(t("media.factory.perDayUsd"), "perDayUsd", "decimal")}
        {field(t("media.factory.perMonthUsd"), "perMonthUsd", "decimal")}
      </div>
      <button type="button" onClick={() => void save()} disabled={busy} className={primaryButton}>
        {busy ? t("common.saving") : t("media.factory.save")}
      </button>
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

// BL-133 (plan §2.3/§2.4, owner O5): further GPU types tried in order when the chosen one cannot be placed in the volume's
// datacenter -- for every session, yours too -- and how long a session waits for a free GPU.
export function GpuFallbackCard({ settings, onChanged }: { settings: Settings; onChanged: () => Promise<void> }) {
  const { t } = useUiText();
  const [fallbackText, setFallbackText] = useState(settings.gpuFallbackIds.join("\n"));
  const [minVram, setMinVram] = useState(settings.gpuMinVramGb === null ? "" : String(settings.gpuMinVramGb));
  const [maxPrice, setMaxPrice] = useState(settings.gpuMaxPricePerHr === null ? "" : String(settings.gpuMaxPricePerHr));
  const [retrySeconds, setRetrySeconds] = useState(String(settings.capacityRetrySeconds));
  const [waitMinutes, setWaitMinutes] = useState(String(settings.capacityWaitMinutes));
  // BL-155: "" = no filter (null); otherwise one of RunPod's known CUDA versions.
  const [minCuda, setMinCuda] = useState(settings.minCudaVersion ?? "");
  const [busy, setBusy] = useState(false);
  // Re-read when the settings change (a save, or a value applied from the other computer), like the other Setup cards: a form
  // still showing the old value would send it back with the next save and undo the other computer's change (BL-150 review).
  const fallbackKey = settings.gpuFallbackIds.join("\n");
  useEffect(() => {
    setFallbackText(fallbackKey);
    setMinVram(settings.gpuMinVramGb === null ? "" : String(settings.gpuMinVramGb));
    setMaxPrice(settings.gpuMaxPricePerHr === null ? "" : String(settings.gpuMaxPricePerHr));
    setRetrySeconds(String(settings.capacityRetrySeconds));
    setWaitMinutes(String(settings.capacityWaitMinutes));
    setMinCuda(settings.minCudaVersion ?? "");
  }, [fallbackKey, settings.gpuMinVramGb, settings.gpuMaxPricePerHr, settings.capacityRetrySeconds, settings.capacityWaitMinutes, settings.minCudaVersion]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save() {
    const gpuFallbackIds = fallbackText
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter(Boolean);
    const gpuMinVramGb = minVram.trim() ? parseInteger(minVram, { min: 1, max: 1024 }) : null;
    const gpuMaxPricePerHr = maxPrice.trim() ? parseMoney(maxPrice) : null;
    const capacityRetrySeconds = parseInteger(retrySeconds, { min: 15, max: 3600 });
    const capacityWaitMinutes = parseInteger(waitMinutes, { min: 1, max: 1440 });
    const minCudaVersion = MEDIA_CUDA_VERSIONS.find((v) => v === minCuda) ?? null;
    if ((minVram.trim() && gpuMinVramGb === null) || (maxPrice.trim() && gpuMaxPricePerHr === null) || capacityRetrySeconds === null || capacityWaitMinutes === null || gpuFallbackIds.length > 10) {
      setError(t("media.fallback.invalid"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/media-generation/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(onlyChangedSettings({ gpuFallbackIds, gpuMinVramGb, gpuMaxPricePerHr, capacityRetrySeconds, capacityWaitMinutes, minCudaVersion }, settings)),
      });
      setNotice(t("common.saved"));
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.common.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={t("media.fallback.title")}
      help={t("media.fallback.help")}
    >
      <label className="block text-xs text-zinc-400">
        {t("media.fallback.types")}
        {/* ui-text-ignore: sample RunPod GPU type ids */}
        <textarea value={fallbackText} onChange={(e) => setFallbackText(e.target.value)} className={`${inputClass} h-24 font-mono text-xs`} placeholder={"NVIDIA GeForce RTX 5090\nNVIDIA L40S"} />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-zinc-400">
          {t("media.fallback.minVram")}
          <input type="text" inputMode="numeric" value={minVram} onChange={(e) => setMinVram(e.target.value)} className={inputClass} placeholder={t("media.fallback.noMinimum")} />
        </label>
        <label className="block text-xs text-zinc-400">
          {t("media.fallback.maxPrice")}
          <input type="text" inputMode="decimal" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} className={inputClass} placeholder={t("media.fallback.noCap")} />
        </label>
        <label className="block text-xs text-zinc-400">
          {t("media.fallback.retry")}
          <input type="text" inputMode="numeric" value={retrySeconds} onChange={(e) => setRetrySeconds(e.target.value)} className={inputClass} />
        </label>
        <label className="block text-xs text-zinc-400">
          {t("media.fallback.wait")}
          <input type="text" inputMode="numeric" value={waitMinutes} onChange={(e) => setWaitMinutes(e.target.value)} className={inputClass} />
        </label>
        <label className="block text-xs text-zinc-400">
          <span className="flex items-center gap-1">
            {t("media.fallback.minCuda")}
            <InfoTooltip>{t("media.fallback.minCudaHelp")}</InfoTooltip>
          </span>
          <select value={minCuda} onChange={(e) => setMinCuda(e.target.value)} className={inputClass}>
            <option value="">{t("media.fallback.noCudaFilter")}</option>
            {MEDIA_CUDA_VERSIONS.map((v) => (
              <option key={v} value={v}>
                {/* ui-text-ignore: a CUDA version number */}
                {`CUDA ${v}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button type="button" onClick={save} disabled={busy} className={primaryButton}>
        {busy ? t("common.saving") : t("media.fallback.save")}
      </button>
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

// BL-133 (plan §2.5): every pod start attempt -- which GPU, where, placed or not. Read on demand.
export function CapacityLogCard() {
  const { t } = useUiText();
  const [attempts, setAttempts] = useState<MediaCapacityAttempt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      requestJson<{ attempts: MediaCapacityAttempt[] }>("/api/media-generation/capacity").then(
        (data) => {
          setAttempts(data.attempts);
          setError(null);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : t("media.capacity.loadFailed"))
      ),
    [t]
  );
  return (
    <Card title={t("media.capacity.title")} help={t("media.capacity.help")}>
      <button type="button" onClick={load} className={secondaryButton}>
        {attempts ? t("media.common.refresh") : t("media.capacity.load")}
      </button>
      {attempts && attempts.length === 0 && <p className="text-xs text-zinc-500">{t("media.capacity.none")}</p>}
      {attempts && attempts.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-xs text-zinc-400">
            <thead>
              <tr className="text-zinc-500">
                <th className="py-1 pr-3">{t("media.common.colWhen")}</th>
                {/* ui-text-ignore: the hardware acronym, the same in every language */}
                <th className="py-1 pr-3">GPU</th>
                <th className="py-1 pr-3">{t("setupField.datacenterId")}</th>
                <th className="py-1 pr-3">{t("media.capacity.colResult")}</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a, i) => (
                <tr key={`${a.at}-${i}`} className="border-t border-zinc-800 align-top">
                  <td className="py-1 pr-3 whitespace-nowrap">{formatDisplayDateTime(a.at)}</td>
                  <td className="py-1 pr-3">
                    {a.gpuTypeId}
                    {a.pricePerHr !== null ? <span className="text-zinc-500"> · {t("unit.usdPerHour", { value: String(a.pricePerHr) })}</span> : null}
                  </td>
                  <td className="py-1 pr-3">{a.datacenterId ?? "—"}</td>
                  <td className="py-1 pr-3">
                    <span className={a.result === "placed" ? "text-emerald-400" : a.result === "no_capacity" ? "text-amber-400" : "text-red-400"}>{a.result.replace("_", " ")}</span>
                    {a.detail ? <div className="text-zinc-500">{a.detail}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

/**
 * BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-06): Media shows one line per session of the ACTIVE channel that is getting a pod or
 * generating, linking to the full list in Servers → Sessions. Nothing while none is.
 */
export function NowRunningLine({ activeChannelId, sessionsHref }: { activeChannelId: string | null; sessionsHref: string }) {
  const { t } = useMediaText();
  const [sessions, setSessions] = useState<Session[]>([]);

  useEffect(() => {
    if (!activeChannelId) return;
    let cancelled = false;
    // The open sessions (`limits.openSessions`, never cut off), not the latest 50 rows -- a long-running one stays here
    // however many sessions came after it (review round 2).
    const load = () =>
      requestJson<{ limits: { openSessions: Session[] } }>("/api/media-generation/sessions").then(
        (data) => {
          if (!cancelled) setSessions(data.limits.openSessions);
        },
        () => undefined
      );
    void load();
    const timer = setInterval(() => void load(), SESSIONS_SLOW_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeChannelId]);

  const mine = sessions.filter((s) => s.channelId === activeChannelId && GENERATING_STATUSES.has(s.status));
  if (!activeChannelId || mine.length === 0) return null;
  return (
    <div className="space-y-1">
      {mine.map((s) => (
        <p key={s.sessionId} className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
          {/* AC-SM-06: the session (its short id), its GPU and its state. */}
          <span>{t("media.nowRunning.line", { session: s.sessionId.slice(0, 8), gpu: s.gpuTypeId ?? t("media.nowRunning.noGpuYet"), status: mediaStatusLabel(t, s.status) })}</span>
          <Link href={sessionsHref} className="text-emerald-300 underline hover:text-white">
            {t("media.nowRunning.open")}
          </Link>
        </p>
      ))}
    </div>
  );
}
