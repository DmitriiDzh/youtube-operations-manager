"use client";

import { useCallback, useEffect, useState } from "react";
import {
  MAX_CONCURRENT_SESSIONS_RANGE,
  NETWORK_VOLUME_USD_PER_GB_MONTH,
  type MediaCredentialsStatus,
  type MediaGenerationOverview,
  type MediaJob,
  type MediaSession,
  type MediaSessionLimits,
  type MediaCapacityAttempt,
  type MediaControlEventView,
  type MediaModelEntry,
  type MediaSettings,
  type MediaStorageStatus,
  type MediaTemplateSyncResult,
  type MediaWorkflowTemplate,
} from "@/lib/media-generation/contracts";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { ConfirmDialog } from "./confirm-dialog";
import { GatewayTrafficStats, type GatewayTrafficWindowView } from "./gateway-traffic-stats";
import { InfoTooltip } from "./info-tooltip";
import { SettingsSectionRow } from "./settings-section-row";
import { ToggleSwitch } from "./toggle-switch";

// Phase 14 slice 1 (docs/roadmap/plans/PHASE_14_PLAN.md §2.6/§2.9, owner decision D5): the operator
// enters RunPod keys here (stored encrypted per device, never shown again), picks datacenter / GPU /
// volume / template from RunPod's live lists, and sets the spend and watcher limits. Every RunPod
// call behind the setup cards is an explicit click ("Load", "Test", "Create"), never on mount.
//
// Slice 6 (owner, Telegram 2026-10-05, msg 1549): Settings → RunPod keeps ONLY the connection (`RunpodConnectionSettings`);
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
  if (!res.ok) throw new Error((data as { message?: string }).message ?? `Request to ${url} failed (${res.status})`);
  return data as T;
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

/** The media overview (credentials, settings, readiness) and the gateway traffic, shared by Settings → RunPod and Production. */
export function useMediaOverview() {
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
          setLoadError(err instanceof Error ? err.message : "Failed to load media settings");
        }
      ),
    []
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

/** Settings → RunPod (slice 6): only the connection -- the API keys and their test. */
export function RunpodConnectionSettings() {
  const { overview, loadError, refresh } = useMediaOverview();
  if (loadError) return <p className="text-sm text-red-400">{loadError}</p>;
  if (!overview) return <p className="text-sm text-zinc-500">Loading…</p>;
  return (
    <div className="space-y-6">
      <CredentialsCard status={overview.credentials} onChanged={refresh} />
      <p className="text-xs text-zinc-500">Compute, network volume, limits, sessions, models, workflow templates and jobs are in the Production section.</p>
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

function gb(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${bytes} B`;
}

// Phase 14 slice 4 (owner decision D5): the models on the network volume, and "add from Hugging Face"
// through a cheap CPU pod attached to the volume (terminated as soon as the file is there). Every
// listing is one S3 call made on an explicit Load/Refresh; while a pull runs the card refreshes itself.
export function ModelsCard({ configured }: { configured: boolean }) {
  const [models, setModels] = useState<ModelFile[] | null>(null);
  const [pulls, setPulls] = useState<ModelPull[]>([]);
  const [repoId, setRepoId] = useState("");
  const [file, setFile] = useState("");
  const [folder, setFolder] = useState("checkpoints");
  const [revision, setRevision] = useState("");
  const [sha256, setSha256] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelFile | null>(null);
  const [registry, setRegistry] = useState<{ state: "ok" | "unavailable"; error: string | null }>({ state: "ok", error: null });
  const [events, setEvents] = useState<MediaControlEventView[]>([]);
  const [storage, setStorage] = useState<MediaStorageStatus | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      Promise.all([
        requestJson<{ models: ModelFile[]; pulls: ModelPull[]; registry: "ok" | "unavailable"; registryError: string | null; events: MediaControlEventView[] }>("/api/media-generation/models").then(
          (data) => {
            setModels(data.models);
            setPulls(data.pulls);
            setRegistry({ state: data.registry, error: data.registryError });
            setEvents(data.events);
            setError(null);
          },
          (err: unknown) => setError(err instanceof Error ? err.message : "Failed to list the volume")
        ),
        // The volume's size comes from RunPod, not S3: a failure there must not hide the listing.
        requestJson<{ storage: MediaStorageStatus }>("/api/media-generation/storage").then(
          (data) => {
            setStorage(data.storage);
            setStorageError(null);
          },
          (err: unknown) => setStorageError(err instanceof Error ? err.message : "Could not read the volume's size")
        ),
      ]).then(() => undefined),
    []
  );

  const pulling = pulls.some((p) => p.status === "running");
  useEffect(() => {
    if (!pulling) return;
    const timer = setInterval(() => void load(), 15_000);
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
        }),
      });
      setFile("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the pull");
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
      setError(err instanceof Error ? err.message : "Failed to cancel the pull");
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
      setError(err instanceof Error ? err.message : "Failed to delete the model");
    } finally {
      setBusy(false);
    }
  }

  const totalBytes = (models ?? []).reduce((sum, m) => sum + m.bytes, 0);

  return (
    <Card
      title="Models on the volume"
      help="The files under models/ on the network volume, read through RunPod's S3 API (no pod needed). 'Pull from Hugging Face' first checks the file on Hugging Face (size, SHA-256, free space; public repositories only), then starts a small CPU pod attached to the volume that downloads that exact commit, checks the SHA-256 and only then moves the file into models/<folder>/; a mismatch deletes it and fails the pull. The pod is terminated as soon as it is done (a few cents per pull); a GPU session cannot start while a pull is writing. ComfyUI finds the folders through extra_model_paths.yaml."
    >
      {!configured ? (
        <p className="text-xs text-zinc-500">Save credentials and choose a network volume first.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={load} disabled={busy} className={secondaryButton}>
              {models ? "Refresh" : "Load models"}
            </button>
            {models && (
              <span className="text-xs text-zinc-500">
                {models.length} file(s), {gb(totalBytes)} ≈ ${((totalBytes / 1024 ** 3) * NETWORK_VOLUME_USD_PER_GB_MONTH).toFixed(2)}/month of the volume&rsquo;s price
              </span>
            )}
          </div>
          {storage && (
            <p className="text-xs text-zinc-400">
              Volume {storage.volumeId}
              {storage.dataCenterId ? ` (${storage.dataCenterId})` : ""}: {storage.sizeGb} GB rented
              {storage.usedGb !== null ? ` · ${storage.usedGb} GB used · ${storage.freeGb} GB free` : " · usage not reported"} · ${storage.monthlyUsd.toFixed(2)}/month
            </p>
          )}
          {storageError && <p className="text-xs text-amber-400">Volume size: {storageError}</p>}
          {models && registry.state === "unavailable" && (
            <p className="text-xs text-amber-400">The factory template registry cannot be read on this device, so &ldquo;used by&rdquo; shows only this device&rsquo;s templates ({registry.error}).</p>
          )}
          {models && models.length > 0 && (
            <div className="overflow-x-auto">
              <table className="min-w-[560px] w-full text-left text-xs text-zinc-400">
                <thead>
                  <tr className="text-zinc-500">
                    <th className="py-1 pr-3">Folder</th>
                    <th className="py-1 pr-3">File</th>
                    <th className="py-1 pr-3">Size</th>
                    <th className="py-1 pr-3">SHA-256</th>
                    <th className="py-1 pr-3">Used by</th>
                    <th className="py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.key} className="border-t border-zinc-800">
                      <td className="py-1 pr-3">{m.folder}</td>
                      <td className="py-1 pr-3 font-mono">{m.name}</td>
                      <td className="py-1 pr-3 whitespace-nowrap">{gb(m.bytes)}</td>
                      <td className="py-1 pr-3 font-mono" title={m.sha256 ?? "not verified by a pull on this device"}>
                        {m.sha256 ? `${m.sha256.slice(0, 12)}…` : "—"}
                      </td>
                      <td className="py-1 pr-3">
                        {m.usedBy.length === 0 ? "—" : m.usedBy.map((u) => `${u.templateId} v${u.version}${u.source === "owner" ? " (local)" : ""}`).join(", ")}
                      </td>
                      <td className="py-1">
                        <button type="button" onClick={() => setDeleteTarget(m)} disabled={busy} className={dangerButton}>
                          Delete
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
                    <span className={p.status === "running" ? "text-amber-400" : p.status === "done" ? "text-emerald-400" : "text-red-400"}>{p.status}</span>
                    {" · "}
                    <span className="font-mono">{p.repoId}/{p.file}</span>
                    {" → "}
                    {p.expectedKey}
                    {p.bytes !== null ? ` · ${gb(p.bytes)}` : ""}
                    {p.actualSha256 && p.status === "done" ? ` · SHA-256 verified ${p.actualSha256.slice(0, 12)}…` : ""}
                    {p.requestedBy === "factory" ? " · requested by the Factory Operator" : ""}
                    {p.error ? ` · ${p.error}` : ""}
                    {p.podId ? ` · pod ${p.podId}` : " · reserving a pod…"}
                  </span>
                  {p.status === "running" && (
                    <button type="button" onClick={() => cancelPull(p)} disabled={busy} className={secondaryButton}>
                      Cancel
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-2 sm:grid-cols-4">
            <label className="block text-xs text-zinc-400">
              Hugging Face repo
              <input type="text" value={repoId} onChange={(e) => setRepoId(e.target.value)} className={inputClass} placeholder="Comfy-Org/flux1-schnell" />
            </label>
            <label className="block text-xs text-zinc-400">
              File in the repo
              <input type="text" value={file} onChange={(e) => setFile(e.target.value)} className={inputClass} placeholder="flux1-schnell-fp8.safetensors" />
            </label>
            <label className="block text-xs text-zinc-400">
              Folder
              <select value={folder} onChange={(e) => setFolder(e.target.value)} className={inputClass}>
                {MODEL_FOLDERS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-zinc-400">
              Revision (optional)
              <input type="text" value={revision} onChange={(e) => setRevision(e.target.value)} className={inputClass} placeholder="main" />
            </label>
            <label className="block text-xs text-zinc-400 sm:col-span-2">
              Expected SHA-256 (optional: Hugging Face&rsquo;s own hash is used and checked on the pod)
              <input type="text" value={sha256} onChange={(e) => setSha256(e.target.value)} className={`${inputClass} font-mono`} placeholder="64 hex characters" />
            </label>
            <div className="flex items-end">
              <button type="button" onClick={startPull} disabled={busy || pulling || !repoId.trim() || !file.trim()} className={primaryButton}>
                {pulling ? "Pull running…" : "Pull from Hugging Face"}
              </button>
            </div>
          </div>
          <p className="text-xs text-zinc-500">Check each model&rsquo;s licence for your use before pulling it; this app takes no position.</p>
          {events.length > 0 && (
            <details className="text-xs text-zinc-400">
              <summary className="cursor-pointer text-zinc-500">Recent model and template actions ({events.length})</summary>
              <ul className="mt-1 space-y-0.5">
                {events.map((e, i) => (
                  <li key={`${e.at}-${i}`}>
                    {new Date(e.at).toLocaleString()} · {e.actor === "factory" ? "Factory Operator" : e.actor === "sync" ? "automatic sync" : "you"} · {e.action.replace(/_/g, " ")} · <span className="font-mono">{e.subject}</span>
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
          title={`Delete ${deleteTarget.name} from the volume?`}
          description={
            deleteTarget.usedBy.length > 0
              ? `Used by ${deleteTarget.usedBy.map((u) => `${u.templateId} v${u.version}${u.source === "owner" ? " (local)" : ""}`).join(", ")} — jobs of these templates will fail until it is pulled again. There is no undo except pulling it again.`
              : registry.state === "unavailable"
                ? "The factory template registry cannot be read here, so it cannot be checked whether a factory template needs this file. There is no undo except pulling it again."
                : "No template uses this file. It is removed from the network volume; pull it again if a workflow needs it."
          }
          confirmLabel="Delete"
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
        (err: unknown) => setError(err instanceof Error ? err.message : "Failed to load templates")
      ),
    []
  );

  async function syncNow() {
    setBusy(true);
    setError(null);
    try {
      await requestJson("/api/media-generation/workflow-templates/sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      await fetchTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync the templates");
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
        throw new Error("Workflow and parameters must be valid JSON");
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
      setError(err instanceof Error ? err.message : "Failed to import the template");
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
      setError(err instanceof Error ? err.message : "Failed to delete the template");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Workflow templates"
      help="A template is a ComfyUI workflow exported in API format (ComfyUI → Workflow → Export (API)) plus the parameters a job may set: each parameter names a node id and an input of that node, with a type and optional bounds. Every Save node's filename_prefix is rewritten per job so outputs land in that job's folder. Prompts are job parameters, not template content. Factory templates come from the factory template registry (Settings → logical path media_templates), are checked every minute and are read-only here; templates you import yourself stay local and are never touched by the sync."
    >
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={syncNow} disabled={busy} className={secondaryButton}>
          Sync templates
        </button>
        {lastSync && (
          <span className="text-xs text-zinc-500">
            Last sync {new Date(lastSync.at).toLocaleString()} ({lastSync.trigger === "auto" ? "automatic" : lastSync.trigger === "factory" ? "by the Factory Operator" : "by you"}):{" "}
            {lastSync.outcome === "unavailable"
              ? `registry unavailable — ${lastSync.error}`
              : [
                  `${lastSync.installed.length} installed`,
                  `${lastSync.updated.length} updated`,
                  `${lastSync.removed.length} removed`,
                  lastSync.pending.length ? `${lastSync.pending.length} waiting for files` : null,
                  lastSync.invalid.length ? `${lastSync.invalid.length} refused` : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
          </span>
        )}
      </div>
      {lastSync && lastSync.invalid.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-400">
          {lastSync.invalid.map((i) => (
            <li key={`${i.templateId}.${i.version}`}>
              {i.templateId} v{i.version}: {i.reason}
            </li>
          ))}
        </ul>
      )}
      {templates.length === 0 ? (
        <p className="text-xs text-zinc-500">No templates yet.</p>
      ) : (
        <ul className="space-y-1 text-sm text-zinc-300">
          {templates.map((t) => (
            <li key={t.templateId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
              <span>
                <span className="font-medium text-zinc-100">{t.name}</span>{" "}
                <span className={t.source === "factory" ? "rounded bg-sky-950 px-1.5 text-xs text-sky-300" : "rounded bg-zinc-800 px-1.5 text-xs text-zinc-400"}>{t.source === "factory" ? "factory" : "local"}</span>{" "}
                <span className="text-xs text-zinc-500">v{t.version} · {t.nodeCount} nodes · {t.outputNodeIds.length} output node(s) · id {t.templateId}</span>
                <br />
                <span className="text-xs text-zinc-500">
                  {t.parameters.map((p) => `${p.name}${p.required ? "*" : ""}: ${p.type}`).join(", ") || "no parameters"}
                </span>
              </span>
              {t.source === "factory" ? (
                <span className="text-xs text-zinc-500">managed by the factory registry</span>
              ) : (
                <button type="button" onClick={() => setDeleteTarget(t)} disabled={busy} className={dangerButton}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {showImport ? (
        <div className="space-y-2">
          <label className="block text-xs text-zinc-400">
            Name
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="txt2img FLUX" />
          </label>
          <label className="block text-xs text-zinc-400">
            Workflow JSON (API format)
            <textarea value={workflowText} onChange={(e) => setWorkflowText(e.target.value)} className={`${inputClass} h-40 font-mono text-xs`} placeholder='{"3": {"class_type": "KSampler", "inputs": {...}}, ...}' />
          </label>
          <label className="block text-xs text-zinc-400">
            Parameters JSON
            <textarea value={parametersText} onChange={(e) => setParametersText(e.target.value)} className={`${inputClass} h-28 font-mono text-xs`} />
          </label>
          <div className="flex gap-2">
            <button type="button" onClick={importTemplate} disabled={busy || !name.trim() || !workflowText.trim()} className={primaryButton}>
              {busy ? "Importing…" : "Import"}
            </button>
            <button type="button" onClick={() => setShowImport(false)} disabled={busy} className={secondaryButton}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setShowImport(true)} className={secondaryButton}>
          Import a template
        </button>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {deleteTarget && (
        <ConfirmDialog
          title={`Delete the template "${deleteTarget.name}"?`}
          description="Finished jobs keep their own provenance; new jobs can no longer use it."
          confirmLabel="Delete"
          confirmVariant="danger"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={remove}
        />
      )}
    </Card>
  );
}

type Job = MediaJob;

// Phase 14 slice 3: the operator's own manual job (an agent's arrives through MCP in slice 5) and the
// job list; the exchange janitor is run by hand here (dry run first) and daily by the server.
export function JobsCard({ activeChannelId }: { activeChannelId: string | null }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  // Slice 6: several sessions may run at once; a job goes to one RUNNING session of the active channel, chosen here.
  const [openSessions, setOpenSessions] = useState<Array<{ sessionId: string; status: string; channelId: string; podId: string | null; createdAt: string }>>([]);
  const [chosenSessionId, setChosenSessionId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [paramsText, setParamsText] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [janitorReport, setJanitorReport] = useState<string | null>(null);
  const [confirmJanitor, setConfirmJanitor] = useState(false);

  // Only the job list changes every few seconds while a job runs; the templates and the open session are fetched on
  // mount, after an action, and at a slow cadence (review round 11: three endpoints every 5 s for a 2 h job was ~1,400
  // needless requests per hour each).
  const fetchJobs = useCallback(
    () =>
      requestJson<{ jobs: Job[] }>("/api/media-generation/jobs").then(
        (j) => setJobs(j.jobs),
        (err: unknown) => setError(err instanceof Error ? err.message : "Failed to load jobs")
      ),
    []
  );
  const fetchContext = useCallback(
    () =>
      Promise.all([
        requestJson<{ templates: WorkflowTemplate[] }>("/api/media-generation/workflow-templates"),
        requestJson<{ limits: { openSessions: Array<{ sessionId: string; status: string; channelId: string; podId: string | null; createdAt: string }> } }>("/api/media-generation/sessions"),
      ]).then(
        ([t, s]) => {
          setTemplates(t.templates);
          setOpenSessions(s.limits.openSessions);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : "Failed to load jobs")
      ),
    []
  );
  const fetchAll = useCallback(() => Promise.all([fetchJobs(), fetchContext()]).then(() => undefined), [fetchJobs, fetchContext]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const hasActive = jobs.some((j) => !["done", "failed", "cancelled"].includes(j.status));
  useEffect(() => {
    if (!hasActive) return;
    const jobsTimer = setInterval(() => void fetchJobs(), 5_000);
    const contextTimer = setInterval(() => void fetchContext(), 60_000);
    return () => {
      clearInterval(jobsTimer);
      clearInterval(contextTimer);
    };
  }, [hasActive, fetchJobs, fetchContext]);

  async function run() {
    if (!activeChannelId || !targetSession) return;
    setBusy(true);
    setError(null);
    try {
      let params: unknown;
      try {
        params = JSON.parse(paramsText || "{}");
      } catch {
        throw new Error("Parameters must be valid JSON");
      }
      await requestJson("/api/media-generation/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: targetSession.sessionId, channelId: activeChannelId, templateId, params }),
      });
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit the job");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(job: Job) {
    setBusy(true);
    try {
      await requestJson(`/api/media-generation/jobs/${encodeURIComponent(job.jobId)}/cancel`, { method: "POST" });
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel the job");
    } finally {
      setBusy(false);
    }
  }

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
      setJanitorReport(`${dryRun ? `Would delete ${report.wouldDelete.length}` : `Deleted ${report.deleted.length}`} of ${report.scanned} object(s); kept ${report.kept.length}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Janitor failed");
    } finally {
      setBusy(false);
    }
  }

  // A job is submitted for the active channel, to one of ITS running sessions (review round 16; slice 6: several may run).
  const runningHere = openSessions.filter((s) => s.status === "running" && s.channelId === activeChannelId);
  const targetSession = runningHere.find((s) => s.sessionId === chosenSessionId) ?? runningHere[0] ?? null;
  const runningElsewhere = openSessions.some((s) => s.status === "running" && s.channelId !== activeChannelId);
  const canRun = Boolean(activeChannelId) && targetSession !== null && templates.length > 0;

  return (
    <Card
      title="Jobs"
      help="A job fills a template's parameters, submits the prompt to the running session's ComfyUI and, once it finishes, pulls every output over the S3 API into <workspace>/99 Data Exchange/From YTM/media/<jobId>/, deletes it from the volume and registers it in the asset catalog with its provenance. The janitor removes leftovers of finished jobs from the volume (dry run first)."
    >
      {!canRun ? (
        <p className="text-xs text-zinc-500">
          {!activeChannelId
            ? "Select an active channel."
            : targetSession === null
              ? runningElsewhere
                ? "The running sessions belong to other channels; switch the active channel, or request and approve a session for this one (Sessions tab)."
                : "Start a session for this channel first (Sessions tab)."
              : "Import a workflow template first (Workflow templates tab)."}
        </p>
      ) : (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            {runningHere.length > 1 && (
              <label className="block text-xs text-zinc-400 sm:col-span-2">
                Session
                <select value={targetSession?.sessionId ?? ""} onChange={(e) => setChosenSessionId(e.target.value)} className={inputClass}>
                  {runningHere.map((s) => (
                    <option key={s.sessionId} value={s.sessionId}>
                      {s.podId ?? s.sessionId} · requested {formatDisplayDateTime(s.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="block text-xs text-zinc-400">
              Template
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} className={inputClass}>
                <option value="">— choose —</option>
                {templates.map((t) => (
                  <option key={t.templateId} value={t.templateId}>
                    {t.name} v{t.version}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-zinc-400">
              Parameters JSON
              <textarea value={paramsText} onChange={(e) => setParamsText(e.target.value)} className={`${inputClass} h-20 font-mono text-xs`} placeholder='{"prompt": "..."}' />
            </label>
          </div>
          <button type="button" onClick={run} disabled={busy || !templateId} className={primaryButton}>
            {busy ? "Working…" : "Run job"}
          </button>
        </div>
      )}

      {jobs.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-[640px] w-full text-left text-xs text-zinc-400">
            <thead>
              <tr className="text-zinc-500">
                <th className="py-1 pr-3">When</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">By</th>
                <th className="py-1 pr-3">Outputs</th>
                <th className="py-1 pr-3">Error / notes</th>
                <th className="py-1"></th>
              </tr>
            </thead>
            <tbody>
              {jobs.slice(0, 12).map((j) => (
                <tr key={j.jobId} className="border-t border-zinc-800 align-top">
                  <td className="py-1 pr-3 whitespace-nowrap">{formatDisplayDateTime(j.createdAt)}</td>
                  <td className="py-1 pr-3">{j.status}</td>
                  <td className="py-1 pr-3">{j.createdBy}</td>
                  <td className="py-1 pr-3 font-mono">
                    {j.outputs.length === 0 ? "—" : j.outputs.map((o) => (o.localPath ? o.localPath.split(/[\\/]/).slice(-2).join("/") : `${o.filename} (${o.note ?? "pending"})`)).join(", ")}
                  </td>
                  <td className="py-1 pr-3">{j.error ?? ""}</td>
                  <td className="py-1">
                    {["queued", "submitted", "generating"].includes(j.status) && (
                      <button type="button" onClick={() => cancel(j)} disabled={busy} className={secondaryButton}>
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
        <button type="button" onClick={() => janitor(true)} disabled={busy} className={secondaryButton}>
          Janitor: dry run
        </button>
        <button type="button" onClick={() => setConfirmJanitor(true)} disabled={busy} className={dangerButton}>
          Janitor: delete leftovers
        </button>
        {janitorReport && <span className="text-xs text-zinc-400">{janitorReport}</span>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {confirmJanitor && (
        <ConfirmDialog
          title="Delete finished jobs' leftovers from the volume?"
          description="Only objects under exchange/ that this device's ledger says are already in your workspace are deleted (by ledger only). Leftovers of failed or cancelled jobs are KEPT -- they may be the only copy of a finished generation -- for you to pull or remove by hand (scripts/media/s3.sh). Models and reference inputs are never touched."
          confirmLabel="Delete leftovers"
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
const TRANSITIONAL_STATUSES = new Set(["approved", "starting", "stopping"]);
/** Poll fast while a pod is being created or terminated, slower otherwise (an agent's new request still shows up). */
const SESSIONS_FAST_POLL_MS = 5_000;
const SESSIONS_SLOW_POLL_MS = 15_000;

function minutesLabel(seconds: number | null): string {
  if (seconds === null) return "—";
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function sinceLabel(iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}

/** What a row's status means right now, in the operator's words (the start runs in the background since slice 6). */
function statusDetail(s: Session, nowMs: number): string {
  switch (s.status) {
    case "pending":
      return "waiting for your approval";
    case "approved":
      return `creating the pod… ${sinceLabel(s.approvedAt, nowMs)}`;
    case "waiting_capacity":
      // BL-133: no GPU could be placed yet -- no pod, nothing billed; retried until the wait ends.
      return `no free GPU yet (no pod, no cost) · ${s.capacity?.attempts ?? 0} round(s)${s.capacity?.waitUntil ? ` · gives up at ${formatDisplayDateTime(s.capacity.waitUntil)}` : ""}`;
    case "starting":
      return `pod created, waiting for ComfyUI… ${sinceLabel(s.startedAt, nowMs)}`;
    case "running":
      return `ready${s.lastActivityAt ? ` · last activity ${sinceLabel(s.lastActivityAt, nowMs)} ago` : ""}`;
    case "stopping":
      return "terminating the pod…";
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
export function SessionsCard({ ready, activeChannelId, onLimits }: { ready: boolean; activeChannelId: string | null; onLimits?: (limits: SessionLimits) => void }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [limits, setLimits] = useState<SessionLimits | null>(null);
  const [maxMinutesText, setMaxMinutesText] = useState<string>("");
  const [maxUsd, setMaxUsd] = useState<string>("");
  // BL-135: on by default -- a session you request stops by itself a minute after its last job.
  const [releaseWhenDone, setReleaseWhenDone] = useState(true);
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
        (err: unknown) => setError(err instanceof Error ? err.message : "Failed to load sessions")
      ),
    [onLimits]
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

  async function request() {
    if (!activeChannelId) return;
    const parsedMaxUsd = maxUsd.trim() ? parseMoney(maxUsd) : null;
    if (maxUsd.trim() && parsedMaxUsd === null) {
      setError("Max USD must be a positive amount like 2.5");
      return;
    }
    const maxMinutes = maxMinutesText.trim() ? parseInteger(maxMinutesText, { min: 1, max: 1440 }) : null;
    if (maxMinutesText.trim() && maxMinutes === null) {
      setError("Max minutes must be a whole number between 1 and 1440");
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
          releaseWhenDone,
        }),
      });
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to request a session");
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
      setError(err instanceof Error ? err.message : `Failed to ${action} the session`);
    } finally {
      setBusyId(null);
      await fetchAll();
    }
  }

  const activeCount = limits?.activeSessionCount ?? 0;
  const maxConcurrent = limits?.maxConcurrentSessions ?? 1;
  const atLimit = activeCount >= maxConcurrent;
  const recent = sessions.filter((s) => !OPEN_STATUSES.has(s.status)).slice(0, 10);

  function actions(s: Session) {
    const busy = busyId === s.sessionId;
    if (confirming?.sessionId === s.sessionId) {
      const approve = confirming.action === "approve";
      return (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-300">{approve ? `Start a pod? up to $${s.estimateUsd.toFixed(2)} for ${s.maxMinutes} min` : "Terminate the pod now? Running jobs are cut off."}</span>
          <button type="button" onClick={() => act(s, confirming.action)} disabled={busy} className={approve ? primaryButton : dangerButton}>
            {approve ? "Confirm start" : "Confirm stop"}
          </button>
          <button type="button" onClick={() => setConfirming(null)} className={secondaryButton}>
            Cancel
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
            title={atLimit ? `${activeCount} of ${maxConcurrent} sessions are active (Setup → Limits)` : undefined}
            className={primaryButton}
          >
            Approve
          </button>
          <button type="button" onClick={() => act(s, "reject")} disabled={busy} className={secondaryButton}>
            Reject
          </button>
        </div>
      );
    }
    // An `approved` row with no error is still inside createPod in the background: the server refuses a Stop then (it would
    // orphan the pod), so none is offered until the pod exists or the start has reported a problem on the row.
    // After 15 min (start + stop budgets) the start is abandoned by age and the server accepts a Stop again.
    if (s.status === "approved" && !s.error && nowMs - Date.parse(s.approvedAt ?? s.createdAt) < 15 * 60_000) return <span className="text-zinc-500">starting…</span>;
    return (
      <button type="button" onClick={() => setConfirming({ sessionId: s.sessionId, action: "stop" })} disabled={busy} className={dangerButton}>
        Stop
      </button>
    );
  }

  return (
    <Card
      title="Sessions"
      help="A session is one RunPod pod running ComfyUI; several may run at once, up to the limit in Setup. Agents request sessions through MCP (or you do, below); requesting costs nothing. Approving creates the pod in the background (billed per second from that moment) -- the row shows its progress. A pod is terminated when its session is stopped, idle, over its minutes or over its USD cap, or when today's cap is reached -- never 'stopped' (that would keep billing its disk)."
    >
      {limits && (
        <p className="text-xs text-zinc-500">
          Active {activeCount} of {maxConcurrent} · spent today ${limits.spentTodayUsd.toFixed(2)} of ${limits.maxUsdPerDay.toFixed(2)} · idle timeout {limits.idleMinutes} min
        </p>
      )}

      {openSessions.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs text-zinc-400">
            <thead>
              <tr className="text-zinc-500">
                <th className="py-1 pr-3">Requested</th>
                <th className="py-1 pr-3">Channel</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">By / reason</th>
                <th className="py-1 pr-3">Caps</th>
                <th className="py-1 pr-3">Pod</th>
                <th className="py-1 pr-3">Cost so far</th>
                <th className="py-1">Actions</th>
              </tr>
            </thead>
            <tbody>
              {openSessions.map((s) => (
                <tr key={s.sessionId} className="border-t border-zinc-800 align-top">
                  <td className="py-2 pr-3 whitespace-nowrap">{formatDisplayDateTime(s.createdAt)}</td>
                  <td className="py-2 pr-3 font-mono">{s.channelId === activeChannelId ? "this channel" : s.channelId}</td>
                  <td className="py-2 pr-3">
                    <span className={`font-medium ${statusTone[s.status] ?? ""}`}>{s.status}</span>
                    <div className="text-zinc-500">{statusDetail(s, nowMs)}</div>
                    {s.error && <div className="text-amber-400">{s.error}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    {s.requestedBy === "factory" ? "Factory Operator" : s.requestedBy}
                    {s.approvedBy === "factory" ? <div className="text-sky-300">approved by the factory (within its limits)</div> : null}
                    {s.reason ? <div className="text-zinc-500">{s.reason}</div> : null}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {s.maxMinutes} min{s.maxUsd !== null ? ` / $${s.maxUsd}` : ""}
                    <div className="text-zinc-500">
                      est. ${s.estimateUsd.toFixed(2)}
                      {s.fitsToday ? "" : " · over today's cap"}
                    </div>
                  </td>
                  <td className="py-2 pr-3 font-mono">
                    {s.podId ?? "—"}
                    {s.gpuTypeId && <div className="font-sans text-zinc-500">{s.gpuTypeId}</div>}
                    {s.costPerHr !== null && <div className="font-sans text-zinc-500">${s.costPerHr}/h</div>}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{s.startedAt ? `${minutesLabel(s.secondsUsed)} ≈ $${(s.usdCharged ?? 0).toFixed(2)}` : "—"}</td>
                  <td className="py-2">{actions(s)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-zinc-500">No open sessions. Requests from agents appear here automatically.</p>
      )}

      <div className="space-y-2 border-t border-zinc-800 pt-3">
        {!activeChannelId ? (
          <p className="text-xs text-zinc-500">Select an active channel to request a session yourself.</p>
        ) : !ready ? (
          <p className="text-xs text-zinc-500">Finish Settings → RunPod and Production → Setup to request a session.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="block text-xs text-zinc-400">
              Max minutes
              <input type="text" inputMode="numeric" value={maxMinutesText} onChange={(e) => setMaxMinutesText(e.target.value)} className={inputClass} placeholder={`default ${limits?.defaultMaxMinutes ?? 60}`} />
            </label>
            <label className="block text-xs text-zinc-400">
              Max USD (optional)
              <input type="text" inputMode="decimal" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} className={inputClass} placeholder="no cap (e.g. 2.5)" />
            </label>
            <div className="flex items-end">
              <button type="button" onClick={request} disabled={requesting} className={secondaryButton}>
                {requesting ? "Requesting…" : "Request a session for this channel"}
              </button>
            </div>
            <div className="flex items-center gap-2 sm:col-span-3">
              <ToggleSwitch label="Stop by itself when the jobs are done" checked={releaseWhenDone} onChange={setReleaseWhenDone} />
              <span className="text-xs text-zinc-400">Stop the pod by itself one minute after the session&rsquo;s last job finished (instead of waiting for the idle timeout)</span>
            </div>
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <div className="overflow-x-auto">
          <p className="mb-1 text-xs font-medium text-zinc-400">Recent</p>
          <table className="w-full min-w-[640px] text-left text-xs text-zinc-400">
            <thead>
              <tr className="text-zinc-500">
                <th className="py-1 pr-3">When</th>
                <th className="py-1 pr-3">Status</th>
                <th className="py-1 pr-3">By</th>
                <th className="py-1 pr-3">Pod</th>
                <th className="py-1 pr-3">Used</th>
                <th className="py-1 pr-3">Cost</th>
                <th className="py-1">Reason / error</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((s) => (
                <tr key={s.sessionId} className="border-t border-zinc-800">
                  <td className="py-1 pr-3 whitespace-nowrap">{formatDisplayDateTime(s.createdAt)}</td>
                  <td className={`py-1 pr-3 ${statusTone[s.status] ?? ""}`}>{s.status}</td>
                  <td className="py-1 pr-3">{s.requestedBy}</td>
                  <td className="py-1 pr-3 font-mono">{s.podId ?? "—"}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">{minutesLabel(s.secondsUsed)}</td>
                  <td className="py-1 pr-3">{s.usdCharged !== null ? `$${s.usdCharged.toFixed(2)}` : "—"}</td>
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

export function ReadinessBanner({ overview }: { overview: Overview }) {
  if (overview.ready) return <p className="text-xs text-emerald-400">Media generation is configured: agents can request sessions; approve them in Sessions, then jobs run.</p>;
  return <p className="text-xs text-zinc-500">Not ready yet — missing: {overview.missing.join(", ")}.</p>;
}

export function CredentialsCard({ status, onChanged }: { status: CredentialsStatus; onChanged: () => Promise<void> }) {
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
      setNotice("Saved (encrypted on this device).");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
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
      setError(err instanceof Error ? err.message : "Test failed");
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
      setNotice("Credentials removed.");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="RunPod credentials"
      help="The RunPod API key (console → Settings → API Keys; a Restricted key for pods and storage is enough) and, optionally, an S3 API key pair for the network volume (console → Settings → S3 API Keys). Stored encrypted on this computer under a key the app creates itself; never shown again, never sent to an agent."
    >
      {!status.configured && status.reason === "key_file_missing" && (
        <p className="text-xs text-amber-400">Credentials exist in the database but this computer has no matching key file (for example after copying the database). Enter them again.</p>
      )}
      {!status.configured && status.reason === "key_file_invalid" && (
        <div className="space-y-2">
          <p className="text-xs text-red-400">This computer&rsquo;s key file is unreadable (truncated or edited), so the stored credentials cannot be decrypted. Reset removes both; then enter the keys again.</p>
          <button type="button" onClick={() => setConfirmClear(true)} disabled={busy} className={dangerButton}>
            Reset credentials and key file
          </button>
        </div>
      )}

      {status.configured && !editing && (
        <div className="space-y-2">
          <p className="text-sm text-zinc-300">
            RunPod key <span className="font-mono text-zinc-100">{status.runpodKeyPrefix}</span>
            {status.s3AccessKeyId ? (
              <>
                {" · "}S3 key <span className="font-mono text-zinc-100">{status.s3AccessKeyId}</span>
              </>
            ) : (
              <span className="text-zinc-500"> · no S3 key pair</span>
            )}
          </p>
          <p className="text-xs text-zinc-500">
            Saved {formatDisplayDateTime(status.updatedAt)}
            {status.verifiedAt ? ` · last verified ${formatDisplayDateTime(status.verifiedAt)}` : " · not verified yet"}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={test} disabled={busy} className={primaryButton}>
              {busy ? "Working…" : "Test"}
            </button>
            <button type="button" onClick={() => setEditing(true)} disabled={busy} className={secondaryButton}>
              Replace
            </button>
            <button type="button" onClick={() => setConfirmClear(true)} disabled={busy} className={dangerButton}>
              Clear
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="space-y-2">
          <label className="block text-xs text-zinc-400">
            RunPod API key
            <input type="password" autoComplete="off" value={runpodApiKey} onChange={(e) => setRunpodApiKey(e.target.value)} className={inputClass} placeholder="rpa_…" />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-xs text-zinc-400">
              S3 access key id (optional)
              <input type="text" autoComplete="off" value={s3AccessKeyId} onChange={(e) => setS3AccessKeyId(e.target.value)} className={inputClass} placeholder="user_…" />
            </label>
            <label className="block text-xs text-zinc-400">
              S3 secret access key (optional)
              <input type="password" autoComplete="off" value={s3SecretAccessKey} onChange={(e) => setS3SecretAccessKey(e.target.value)} className={inputClass} placeholder="rps_…" />
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={save} disabled={busy || runpodApiKey.trim().length < 16} className={primaryButton}>
              {busy ? "Saving…" : "Save"}
            </button>
            {status.configured && (
              <button type="button" onClick={() => setEditing(false)} disabled={busy} className={secondaryButton}>
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {testResult && (
        <div className="space-y-1 text-xs">
          <p className={testResult.runpod.ok ? "text-emerald-400" : "text-red-400"}>RunPod API: {testResult.runpod.ok ? "OK" : testResult.runpod.message}</p>
          <p className={"skipped" in testResult.s3 ? "text-zinc-500" : testResult.s3.ok ? "text-emerald-400" : "text-red-400"}>
            S3 API: {"skipped" in testResult.s3 ? `skipped (${testResult.s3.reason})` : testResult.s3.ok ? "OK" : testResult.s3.message}
          </p>
        </div>
      )}
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}

      {confirmClear && (
        <ConfirmDialog
          title={!status.configured && status.reason === "key_file_invalid" ? "Reset the RunPod credentials and this computer's key file?" : "Remove the RunPod credentials from this computer?"}
          description={
            !status.configured && status.reason === "key_file_invalid"
              ? "The stored credentials cannot be decrypted with the unreadable key file, so both are removed; a fresh key file is created when you enter the keys again."
              : "Sessions cannot start without them. The per-device key file stays in place."
          }
          confirmLabel="Remove"
          confirmVariant="danger"
          onCancel={() => setConfirmClear(false)}
          onConfirm={clear}
        />
      )}
    </Card>
  );
}

export function ComputeCard({ overview, gatewayTraffic, onChanged }: { overview: Overview; gatewayTraffic: GatewayTrafficWindowView[] | undefined; onChanged: () => Promise<void> }) {
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
      setError(err instanceof Error ? err.message : "Failed to load the RunPod catalog");
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
        body: JSON.stringify({
          datacenterId: draft.datacenterId || null,
          gpuTypeId: draft.gpuTypeId || null,
          cloudType: draft.cloudType,
          templateId: draft.templateId || null,
        }),
      });
      setNotice("Saved.");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
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
      setError(err instanceof Error ? err.message : "Failed to update the toggle");
    }
  }

  const gpuOptions = catalog?.gpus.filter((g) => (draft.cloudType === "SECURE" ? g.secureCloud : g.communityCloud)) ?? [];
  const traffic = (category: string) => gatewayTraffic?.find((c) => c.category === category);

  return (
    <Card
      title="Compute"
      help="Which RunPod datacenter and GPU a generation session uses, and the pod template it starts from. The lists come from RunPod's live catalog on 'Load' (two API calls). The media gateway toggle gates every RunPod, S3 and ComfyUI call this app makes."
    >
      <SettingsSectionRow
        left={
          <div className="flex items-center gap-3">
            <ToggleSwitch label="Enable the media gateway" checked={overview.gatewayEnabled} onChange={toggleGateway} />
            <span className="text-sm text-zinc-300">Media gateway (RunPod API, S3 API, ComfyUI, Hugging Face Hub)</span>
          </div>
        }
        right={
          <div>
            <GatewayTrafficStats size="lg" window={traffic("runpod_api")} />
            <p className="text-xs text-zinc-500">
              S3: {traffic("runpod_s3")?.totalAttempts ?? 0} · ComfyUI: {traffic("comfyui_api")?.totalAttempts ?? 0} · Hugging Face: {traffic("huggingface_api")?.totalAttempts ?? 0} attempts (24h)
            </p>
          </div>
        }
      />

      {!credentials.configured ? (
        <p className="text-xs text-zinc-500">Save RunPod credentials first to load the catalog.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button type="button" onClick={load} disabled={busy} className={secondaryButton}>
              {busy ? "Loading…" : catalog ? "Reload from RunPod" : "Load from RunPod"}
            </button>
            {!catalog && (settings.datacenterId || settings.gpuTypeId) && (
              <span className="text-xs text-zinc-500">
                Saved: {settings.datacenterId ?? "—"} · {settings.gpuTypeId ?? "—"} · {settings.cloudType} · template {settings.templateId ?? "—"}
              </span>
            )}
          </div>
          {catalog && (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-xs text-zinc-400">
                Cloud type
                <select value={draft.cloudType} onChange={(e) => setDraft({ ...draft, cloudType: e.target.value as "SECURE" | "COMMUNITY" })} className={inputClass}>
                  <option value="SECURE">Secure Cloud (network volumes supported)</option>
                  <option value="COMMUNITY">Community Cloud (cheaper, no network volumes)</option>
                </select>
              </label>
              <label className="block text-xs text-zinc-400">
                Datacenter
                <select value={draft.datacenterId} onChange={(e) => setDraft({ ...draft, datacenterId: e.target.value })} className={inputClass}>
                  <option value="">— not set —</option>
                  {catalog.dataCenters.map((dc) => (
                    <option key={dc.id} value={dc.id}>
                      {dc.id}
                      {dc.region ? ` · ${dc.region.toLowerCase().replace(/_/g, " ")}` : ""}
                      {dc.networkVolumeTypes.length > 0 ? ` · volumes: ${dc.networkVolumeTypes.join(", ").toLowerCase().replace(/_/g, " ")}` : " · no network volumes"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-zinc-400 sm:col-span-2">
                GPU type
                <select value={draft.gpuTypeId} onChange={(e) => setDraft({ ...draft, gpuTypeId: e.target.value })} className={inputClass}>
                  <option value="">— not set —</option>
                  {gpuOptions.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.displayName}
                      {g.memoryInGb ? ` · ${g.memoryInGb} GB` : ""}
                      {g.onDemandPricePerHr !== null ? ` · $${g.onDemandPricePerHr.toFixed(2)}/h` : ""}
                      {draft.datacenterId
                        ? (() => {
                            const here = g.dataCenters.find((dc) => dc.id === draft.datacenterId);
                            return here ? ` · ${(here.estimatedAvailability ?? "available").toLowerCase()} in ${draft.datacenterId}` : ` · not available in ${draft.datacenterId} now`;
                          })()
                        : g.estimatedAvailability
                          ? ` · ${g.estimatedAvailability.toLowerCase()} availability`
                          : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-zinc-400 sm:col-span-2">
                Pod template
                <select value={draft.templateId} onChange={(e) => setDraft({ ...draft, templateId: e.target.value })} className={inputClass}>
                  <option value="">— not set —</option>
                  {(templates ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.id})
                    </option>
                  ))}
                </select>
              </label>
              <div className="sm:col-span-2">
                <button type="button" onClick={save} disabled={busy} className={primaryButton}>
                  {busy ? "Saving…" : "Save compute settings"}
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

  useEffect(() => {
    setSelected(settings.networkVolumeId ?? "");
  }, [settings.networkVolumeId]);

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setVolumes((await requestJson<{ volumes: Volume[] }>("/api/media-generation/network-volumes")).volumes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load volumes");
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
        body: JSON.stringify({ networkVolumeId: selected || null }),
      });
      setNotice("Saved.");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
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
      setNotice(`Created ${volume.name} (${volume.id}).`);
      await load();
      setSelected(volume.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the volume");
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
      setNotice(`${volume.name} is now ${volume.sizeGb} GB.`);
      setGrowSizeText("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to resize the volume");
    } finally {
      setBusy(false);
    }
  }

  const selectedVolume = volumes?.find((v) => v.id === selected);
  const monthly = (gb: number) => (gb * NETWORK_VOLUME_USD_PER_GB_MONTH).toFixed(2);
  // RunPod only grows a network volume (its API refuses a smaller size), so the field accepts current + 1 GB and up.
  const growSize = selectedVolume && selectedVolume.sizeGb < 4000 ? parseInteger(growSizeText, { min: selectedVolume.sizeGb + 1, max: 4000 }) : null;

  return (
    <Card
      title="Network volume"
      help="The RunPod network volume that holds the models (and the exchange folder). Billed by RunPod monthly per GB from creation until deletion, whether or not a pod is running. Must be in the chosen datacenter."
    >
      {!credentials.configured ? (
        <p className="text-xs text-zinc-500">Save RunPod credentials first.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={load} disabled={busy} className={secondaryButton}>
              {busy ? "Loading…" : volumes ? "Reload volumes" : "Load volumes"}
            </button>
            {!volumes && <span className="text-xs text-zinc-500">Saved: {settings.networkVolumeId ?? "—"}</span>}
          </div>
          {volumes && (
            <div className="space-y-2">
              <label className="block text-xs text-zinc-400">
                Volume
                <select value={selected} onChange={(e) => setSelected(e.target.value)} className={inputClass}>
                  <option value="">— not set —</option>
                  {volumes.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} · {v.dataCenterId} · {v.sizeGb} GB{v.usedSizeGb !== null ? ` (${v.usedSizeGb} used)` : ""} · ${monthly(v.sizeGb)}/month
                    </option>
                  ))}
                </select>
              </label>
              {selectedVolume && settings.datacenterId && selectedVolume.dataCenterId !== settings.datacenterId && (
                <p className="text-xs text-amber-400">
                  This volume is in {selectedVolume.dataCenterId}; the chosen datacenter is {settings.datacenterId}. Saving will be refused.
                </p>
              )}
              <button type="button" onClick={saveSelection} disabled={busy} className={primaryButton}>
                {busy ? "Saving…" : "Save volume"}
              </button>
              {selectedVolume && (
                <div className="mt-3 border-t border-zinc-800 pt-3">
                  <p className="mb-2 text-xs text-zinc-400">
                    Grow {selectedVolume.name}: now {selectedVolume.sizeGb} GB{selectedVolume.usedSizeGb !== null ? ` (${selectedVolume.usedSizeGb} used)` : ""} · ${monthly(selectedVolume.sizeGb)}/month. RunPod can only make a
                    network volume larger, never smaller.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={growSizeText}
                      onChange={(e) => setGrowSizeText(e.target.value)}
                      className={inputClass}
                      placeholder={selectedVolume.sizeGb < 4000 ? `new size, ${selectedVolume.sizeGb + 1}–4000 GB` : "already at 4000 GB"}
                      disabled={selectedVolume.sizeGb >= 4000}
                    />
                    <button type="button" onClick={() => setConfirmGrow(true)} disabled={busy || growSize === null} className={secondaryButton}>
                      Grow ({growSize === null ? `size ${selectedVolume.sizeGb + 1}–4000 GB` : `$${monthly(growSize)}/month`})
                    </button>
                  </div>
                </div>
              )}
              <div className="mt-3 border-t border-zinc-800 pt-3">
                <p className="mb-2 text-xs text-zinc-400">Create a new volume in {settings.datacenterId ?? "the chosen datacenter (set it under Compute first)"}:</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} className={inputClass} placeholder="name" />
                  <input type="text" inputMode="numeric" value={newSizeText} onChange={(e) => setNewSizeText(e.target.value)} className={inputClass} placeholder="10–4000" />
                  <button type="button" onClick={() => setConfirmCreate(true)} disabled={busy || !settings.datacenterId || !newName.trim() || newSize === null} className={secondaryButton}>
                    Create ({newSize === null ? "size 10–4000 GB" : `$${monthly(newSize)}/month`})
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
          title={`Create a ${newSize} GB network volume in ${settings.datacenterId}?`}
          description={`RunPod bills about $${monthly(newSize ?? 0)} per month for it from now until you delete it in the RunPod console.`}
          confirmLabel="Create volume"
          onCancel={() => setConfirmCreate(false)}
          onConfirm={create}
        />
      )}
      {confirmGrow && selectedVolume && growSize !== null && (
        <ConfirmDialog
          title={`Grow ${selectedVolume.name} from ${selectedVolume.sizeGb} GB to ${growSize} GB?`}
          description={`RunPod bills about $${monthly(growSize)} per month for it from now on (+$${monthly(growSize - selectedVolume.sizeGb)}). This cannot be undone: RunPod never shrinks a network volume.`}
          confirmLabel="Grow volume"
          onCancel={() => setConfirmGrow(false)}
          onConfirm={grow}
        />
      )}
    </Card>
  );
}

export function LimitsCard({ settings, onChanged }: { settings: Settings; onChanged: () => Promise<void> }) {
  // Every field is a controlled text input parsed on save (parseInteger / parseMoney): never a native number widget
  // (locale-dependent, and a cleared field would silently become 0).
  const [draft, setDraft] = useState({
    defaultMaxMinutes: String(settings.defaultMaxMinutes),
    idleMinutes: String(settings.idleMinutes),
    watchIntervalSeconds: String(settings.watchIntervalSeconds),
    maxConcurrentSessions: String(settings.maxConcurrentSessions),
  });
  const [maxUsdPerDayText, setMaxUsdPerDayText] = useState(String(settings.maxUsdPerDay));
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
  }, [settings.maxUsdPerDay, settings.defaultMaxMinutes, settings.idleMinutes, settings.watchIntervalSeconds, settings.maxConcurrentSessions]);

  async function save() {
    const maxUsdPerDay = parseMoney(maxUsdPerDayText);
    if (maxUsdPerDay === null) {
      setError("Max USD per day must be a positive amount like 10 or 2.5");
      return;
    }
    const defaultMaxMinutes = parseInteger(draft.defaultMaxMinutes, { min: 1, max: 1440 });
    const idleMinutes = parseInteger(draft.idleMinutes, { min: 1, max: 1440 });
    const watchIntervalSeconds = parseInteger(draft.watchIntervalSeconds, { min: 15, max: 3600 });
    const maxConcurrentSessions = parseInteger(draft.maxConcurrentSessions, MAX_CONCURRENT_SESSIONS_RANGE);
    if (defaultMaxMinutes === null || idleMinutes === null || watchIntervalSeconds === null || maxConcurrentSessions === null) {
      setError(
        `Session length and idle timeout must be whole minutes (1–1440); the watch interval whole seconds (15–3600); concurrent sessions a whole number (${MAX_CONCURRENT_SESSIONS_RANGE.min}–${MAX_CONCURRENT_SESSIONS_RANGE.max})`
      );
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/media-generation/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxUsdPerDay, defaultMaxMinutes, idleMinutes, watchIntervalSeconds, maxConcurrentSessions }) });
      setNotice("Saved.");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
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
      title="Limits"
      help="Daily spend cap across all sessions; the default length of a session request; how long a running session may sit without jobs before its pod is terminated; and how often the watcher checks (at least every 15 seconds); and how many sessions may hold a pod at the same time (each is its own pod, billed separately; an approve beyond the limit is refused and the request stays pending)."
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-zinc-400">
          Max USD per day
          <input type="text" inputMode="decimal" value={maxUsdPerDayText} onChange={(e) => setMaxUsdPerDayText(e.target.value)} className={inputClass} placeholder="e.g. 10" />
        </label>
        {field("Default session length (minutes)", "defaultMaxMinutes", { min: 1, max: 1440 })}
        {field("Idle timeout (minutes)", "idleMinutes", { min: 1, max: 1440 })}
        {field("Watch interval (seconds)", "watchIntervalSeconds", { min: 15, max: 3600 })}
        {field("Concurrent sessions (pods at once)", "maxConcurrentSessions", MAX_CONCURRENT_SESSIONS_RANGE)}
      </div>
      <button type="button" onClick={save} disabled={busy} className={primaryButton}>
        {busy ? "Saving…" : "Save limits"}
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
      setError("USD limits must be positive amounts like 2 or 2.5; minutes a whole number 1–1440");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/media-generation/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ factorySessionsEnabled: nextEnabled, factoryMaxUsdPerSession, factoryMaxMinutesPerSession, factoryMaxUsdPerDay, factoryMaxUsdPerMonth }),
      });
      setNotice("Saved.");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
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
      title="Factory Operator limits"
      help="Sessions the Factory Operator starts itself (to test models and templates). Within ALL of these limits -- and the device limits above -- its start is approved by the factory and the pod starts without you; above any of them the request waits in Sessions for your approval. The factory can stop only the sessions it started. Day and month are this computer's calendar day and month; a running factory session counts with its full USD cap until it ends."
    >
      <div className="flex items-center gap-3">
        <ToggleSwitch
          label="Let the Factory Operator start sessions within these limits"
          checked={enabled}
          onChange={(next) => {
            setEnabled(next);
            void save(next);
          }}
          disabled={busy}
        />
        <span className="text-sm text-zinc-300">Factory Operator may start sessions within these limits</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {field("Per session, USD", "perSessionUsd", "decimal")}
        {field("Per session, minutes", "perSessionMinutes", "numeric")}
        {field("Per day, USD (factory sessions)", "perDayUsd", "decimal")}
        {field("Per month, USD (factory sessions)", "perMonthUsd", "decimal")}
      </div>
      <button type="button" onClick={() => void save()} disabled={busy} className={primaryButton}>
        {busy ? "Saving…" : "Save factory limits"}
      </button>
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

// BL-133 (plan §2.3/§2.4, owner O5): further GPU types tried in order when the chosen one cannot be placed in the volume's
// datacenter -- for every session, yours too -- and how long a session waits for a free GPU.
export function GpuFallbackCard({ settings, onChanged }: { settings: Settings; onChanged: () => Promise<void> }) {
  const [fallbackText, setFallbackText] = useState(settings.gpuFallbackIds.join("\n"));
  const [minVram, setMinVram] = useState(settings.gpuMinVramGb === null ? "" : String(settings.gpuMinVramGb));
  const [maxPrice, setMaxPrice] = useState(settings.gpuMaxPricePerHr === null ? "" : String(settings.gpuMaxPricePerHr));
  const [retrySeconds, setRetrySeconds] = useState(String(settings.capacityRetrySeconds));
  const [waitMinutes, setWaitMinutes] = useState(String(settings.capacityWaitMinutes));
  const [busy, setBusy] = useState(false);
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
    if ((minVram.trim() && gpuMinVramGb === null) || (maxPrice.trim() && gpuMaxPricePerHr === null) || capacityRetrySeconds === null || capacityWaitMinutes === null || gpuFallbackIds.length > 10) {
      setError("Up to 10 GPU types; minimum VRAM whole GB; price cap a positive amount; retry 15–3600 s; wait 1–1440 min");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/media-generation/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ gpuFallbackIds, gpuMinVramGb, gpuMaxPricePerHr, capacityRetrySeconds, capacityWaitMinutes }),
      });
      setNotice("Saved.");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="GPU fallback and capacity wait"
      help="When the GPU chosen above cannot be placed in the volume's datacenter, these GPU types are tried in order (RunPod catalog ids, one per line, e.g. NVIDIA GeForce RTX 5090). A type under the minimum VRAM, over the price cap or not offered in the datacenter is skipped. When none is free, the session waits with no pod (nothing is billed), is retried every few seconds as set here, and fails with 'no capacity' after the wait. A template from the factory registry may bring its own list."
    >
      <label className="block text-xs text-zinc-400">
        Fallback GPU types, in order
        <textarea value={fallbackText} onChange={(e) => setFallbackText(e.target.value)} className={`${inputClass} h-24 font-mono text-xs`} placeholder={"NVIDIA GeForce RTX 5090\nNVIDIA L40S"} />
      </label>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-zinc-400">
          Minimum VRAM, GB (optional)
          <input type="text" inputMode="numeric" value={minVram} onChange={(e) => setMinVram(e.target.value)} className={inputClass} placeholder="no minimum" />
        </label>
        <label className="block text-xs text-zinc-400">
          Price cap, USD per hour (optional)
          <input type="text" inputMode="decimal" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} className={inputClass} placeholder="no cap" />
        </label>
        <label className="block text-xs text-zinc-400">
          Retry every (seconds, 15–3600)
          <input type="text" inputMode="numeric" value={retrySeconds} onChange={(e) => setRetrySeconds(e.target.value)} className={inputClass} />
        </label>
        <label className="block text-xs text-zinc-400">
          Give up after (minutes, 1–1440)
          <input type="text" inputMode="numeric" value={waitMinutes} onChange={(e) => setWaitMinutes(e.target.value)} className={inputClass} />
        </label>
      </div>
      <button type="button" onClick={save} disabled={busy} className={primaryButton}>
        {busy ? "Saving…" : "Save GPU fallback"}
      </button>
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}

// BL-133 (plan §2.5): every pod start attempt -- which GPU, where, placed or not. Read on demand.
export function CapacityLogCard() {
  const [attempts, setAttempts] = useState<MediaCapacityAttempt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      requestJson<{ attempts: MediaCapacityAttempt[] }>("/api/media-generation/capacity").then(
        (data) => {
          setAttempts(data.attempts);
          setError(null);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : "Failed to load the capacity log")
      ),
    []
  );
  return (
    <Card title="Pod start attempts" help="Every attempt to create a session's pod in the last 90 days: the GPU type, the datacenter, the price, and whether RunPod placed it. 'no capacity' means no such GPU was free there at that moment.">
      <button type="button" onClick={load} className={secondaryButton}>
        {attempts ? "Refresh" : "Load attempts"}
      </button>
      {attempts && attempts.length === 0 && <p className="text-xs text-zinc-500">No attempts yet.</p>}
      {attempts && attempts.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-xs text-zinc-400">
            <thead>
              <tr className="text-zinc-500">
                <th className="py-1 pr-3">When</th>
                <th className="py-1 pr-3">GPU</th>
                <th className="py-1 pr-3">Datacenter</th>
                <th className="py-1 pr-3">Result</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a, i) => (
                <tr key={`${a.at}-${i}`} className="border-t border-zinc-800 align-top">
                  <td className="py-1 pr-3 whitespace-nowrap">{formatDisplayDateTime(a.at)}</td>
                  <td className="py-1 pr-3">
                    {a.gpuTypeId}
                    {a.pricePerHr !== null ? <span className="text-zinc-500"> · ${a.pricePerHr}/h</span> : null}
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
