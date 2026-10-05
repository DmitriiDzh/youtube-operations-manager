"use client";

import { useCallback, useEffect, useState } from "react";
import { NETWORK_VOLUME_USD_PER_GB_MONTH } from "@/lib/media-generation/contracts";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { ConfirmDialog } from "./confirm-dialog";
import { GatewayTrafficStats, type GatewayTrafficWindowView } from "./gateway-traffic-stats";
import { InfoTooltip } from "./info-tooltip";
import { OperationOverlay, useOperation } from "./operation-progress";
import { SettingsSectionRow } from "./settings-section-row";
import { ToggleSwitch } from "./toggle-switch";

// Phase 14 slice 1 (docs/roadmap/plans/PHASE_14_PLAN.md §2.6/§2.9, owner decision D5): the operator
// enters RunPod keys here (stored encrypted per device, never shown again), picks datacenter / GPU /
// volume / template from RunPod's live lists, and sets the spend and watcher limits. Every RunPod
// call behind this card is an explicit click ("Load", "Test", "Create"), never on mount.

type CredentialsStatus =
  | { configured: false; reason: "no_credentials" | "key_file_missing" }
  | { configured: true; runpodKeyPrefix: string; s3AccessKeyId: string | null; verifiedAt: string | null; updatedAt: string };

type Settings = {
  datacenterId: string | null;
  gpuTypeId: string | null;
  cloudType: "SECURE" | "COMMUNITY";
  networkVolumeId: string | null;
  templateId: string | null;
  maxUsdPerDay: number;
  defaultMaxMinutes: number;
  idleMinutes: number;
  watchIntervalSeconds: number;
};

type Overview = { credentials: CredentialsStatus; settings: Settings; gatewayEnabled: boolean; ready: boolean; missing: string[] };

type Gpu = { id: string; displayName: string; memoryInGb: number | null; onDemandPricePerHr: number | null; estimatedAvailability: string | null; secureCloud: boolean; communityCloud: boolean };
type DataCenter = { id: string; countryCode: string | null; region: string | null };
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

export function MediaGenerationSettings({ activeChannelId = null }: { activeChannelId?: string | null }) {
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

  // Traffic stats are decorative; the card works without them.
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

  if (loadError) return <p className="text-sm text-red-400">{loadError}</p>;
  if (!overview) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <div className="space-y-6">
      <ReadinessBanner overview={overview} />
      <CredentialsCard status={overview.credentials} onChanged={refresh} />
      <ComputeCard overview={overview} gatewayTraffic={gatewayTraffic} onChanged={refresh} />
      <VolumeCard overview={overview} onChanged={refresh} />
      <LimitsCard settings={overview.settings} onChanged={refresh} />
      <SessionsCard ready={overview.ready} activeChannelId={activeChannelId} />
      <ModelsCard configured={overview.credentials.configured && Boolean(overview.settings.networkVolumeId)} />
      <WorkflowTemplatesCard />
      <JobsCard activeChannelId={activeChannelId} />
    </div>
  );
}

type ModelFile = { key: string; folder: string; name: string; bytes: number; lastModified: string | null };
type ModelPull = { pullId: string; podId: string | null; repoId: string; file: string; expectedKey: string; status: string; startedAt: string; finishedAt: string | null; bytes: number | null; error: string | null };
const MODEL_FOLDERS = ["checkpoints", "diffusion_models", "text_encoders", "vae", "loras", "clip_vision", "audio_encoders", "upscale_models", "controlnet", "embeddings"];

function gb(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${bytes} B`;
}

// Phase 14 slice 4 (owner decision D5): the models on the network volume, and "add from Hugging Face"
// through a cheap CPU pod attached to the volume (terminated as soon as the file is there). Every
// listing is one S3 call made on an explicit Load/Refresh; while a pull runs the card refreshes itself.
function ModelsCard({ configured }: { configured: boolean }) {
  const [models, setModels] = useState<ModelFile[] | null>(null);
  const [pulls, setPulls] = useState<ModelPull[]>([]);
  const [repoId, setRepoId] = useState("");
  const [file, setFile] = useState("");
  const [folder, setFolder] = useState("checkpoints");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelFile | null>(null);

  const load = useCallback(
    () =>
      requestJson<{ models: ModelFile[]; pulls: ModelPull[] }>("/api/media-generation/models").then(
        (data) => {
          setModels(data.models);
          setPulls(data.pulls);
          setError(null);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : "Failed to list the volume")
      ),
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
        body: JSON.stringify({ repoId: repoId.trim(), file: file.trim(), folder }),
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
      help="The files under models/ on the network volume, read through RunPod's S3 API (no pod needed). 'Pull from Hugging Face' starts a small CPU pod attached to the volume that downloads one file straight into models/<folder>/ and is terminated as soon as the file is there (a few cents per pull); a GPU session cannot start while a pull is writing. ComfyUI finds the folders through extra_model_paths.yaml."
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
          {models && models.length > 0 && (
            <div className="overflow-x-auto">
              <table className="min-w-[560px] w-full text-left text-xs text-zinc-400">
                <thead>
                  <tr className="text-zinc-500">
                    <th className="py-1 pr-3">Folder</th>
                    <th className="py-1 pr-3">File</th>
                    <th className="py-1 pr-3">Size</th>
                    <th className="py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.key} className="border-t border-zinc-800">
                      <td className="py-1 pr-3">{m.folder}</td>
                      <td className="py-1 pr-3 font-mono">{m.name}</td>
                      <td className="py-1 pr-3 whitespace-nowrap">{gb(m.bytes)}</td>
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
            <div className="flex items-end">
              <button type="button" onClick={startPull} disabled={busy || pulling || !repoId.trim() || !file.trim()} className={primaryButton}>
                {pulling ? "Pull running…" : "Pull from Hugging Face"}
              </button>
            </div>
          </div>
          <p className="text-xs text-zinc-500">Check each model&rsquo;s licence for your use before pulling it; this app takes no position.</p>
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {deleteTarget && (
        <ConfirmDialog
          title={`Delete ${deleteTarget.name} from the volume?`}
          description="The file is removed from the network volume; pull it again if a workflow needs it."
          confirmLabel="Delete"
          confirmVariant="danger"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={remove}
        />
      )}
    </Card>
  );
}

type WorkflowTemplate = { templateId: string; name: string; version: number; description: string | null; parameters: Array<{ name: string; type: string; required: boolean; default: unknown; description: string | null }>; outputNodeIds: string[]; nodeCount: number };

// Phase 14 slice 3 (owner decision D7): templates are imported by the operator -- a ComfyUI API-format
// graph (Save As (API Format) in ComfyUI) plus the parameters an agent may set. Prompts are job
// parameters, never part of a template.
function WorkflowTemplatesCard() {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [name, setName] = useState("");
  const [workflowText, setWorkflowText] = useState("");
  const [parametersText, setParametersText] = useState('[\n  { "name": "prompt", "type": "text", "nodeId": "6", "input": "text", "required": true }\n]');
  const [showImport, setShowImport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkflowTemplate | null>(null);

  const fetchTemplates = useCallback(
    () =>
      requestJson<{ templates: WorkflowTemplate[] }>("/api/media-generation/workflow-templates").then(
        (data) => setTemplates(data.templates),
        (err: unknown) => setError(err instanceof Error ? err.message : "Failed to load templates")
      ),
    []
  );

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
      help="A template is a ComfyUI workflow exported in API format (ComfyUI → Workflow → Export (API)) plus the parameters a job may set: each parameter names a node id and an input of that node, with a type and optional bounds. Every Save node's filename_prefix is rewritten per job so outputs land in that job's folder. Prompts are job parameters, not template content."
    >
      {templates.length === 0 ? (
        <p className="text-xs text-zinc-500">No templates yet.</p>
      ) : (
        <ul className="space-y-1 text-sm text-zinc-300">
          {templates.map((t) => (
            <li key={t.templateId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
              <span>
                <span className="font-medium text-zinc-100">{t.name}</span> <span className="text-xs text-zinc-500">v{t.version} · {t.nodeCount} nodes · {t.outputNodeIds.length} output node(s) · id {t.templateId}</span>
                <br />
                <span className="text-xs text-zinc-500">
                  {t.parameters.map((p) => `${p.name}${p.required ? "*" : ""}: ${p.type}`).join(", ") || "no parameters"}
                </span>
              </span>
              <button type="button" onClick={() => setDeleteTarget(t)} disabled={busy} className={dangerButton}>
                Delete
              </button>
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

type Job = {
  jobId: string;
  sessionId: string;
  templateId: string;
  status: string;
  createdBy: string;
  params: Record<string, string | number | boolean>;
  outputs: Array<{ filename: string; localPath: string | null; note: string | null; assetId: string | null }>;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

// Phase 14 slice 3: the operator's own manual job (an agent's arrives through MCP in slice 5) and the
// job list; the exchange janitor is run by hand here (dry run first) and daily by the server.
function JobsCard({ activeChannelId }: { activeChannelId: string | null }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [openSession, setOpenSession] = useState<{ sessionId: string; status: string } | null>(null);
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
        requestJson<{ limits: { openSession: { sessionId: string; status: string } | null } }>("/api/media-generation/sessions"),
      ]).then(
        ([t, s]) => {
          setTemplates(t.templates);
          setOpenSession(s.limits.openSession);
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
    if (!activeChannelId || !openSession) return;
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
        body: JSON.stringify({ sessionId: openSession.sessionId, channelId: activeChannelId, templateId, params }),
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
      const report = await requestJson<{ scanned: number; deleted: string[]; kept: Array<{ key: string; reason: string }> }>("/api/media-generation/exchange/janitor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      setJanitorReport(`${dryRun ? "Would delete" : "Deleted"} ${report.deleted.length} of ${report.scanned} object(s); kept ${report.kept.length}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Janitor failed");
    } finally {
      setBusy(false);
    }
  }

  const canRun = Boolean(activeChannelId) && openSession?.status === "running" && templates.length > 0;

  return (
    <Card
      title="Jobs"
      help="A job fills a template's parameters, submits the prompt to the running session's ComfyUI and, once it finishes, pulls every output over the S3 API into <workspace>/99 Data Exchange/From YTM/media/<jobId>/, deletes it from the volume and registers it in the asset catalog with its provenance. The janitor removes leftovers of finished jobs from the volume (dry run first)."
    >
      {!canRun ? (
        <p className="text-xs text-zinc-500">
          {!activeChannelId ? "Select an active channel." : openSession?.status !== "running" ? "Start a session first." : "Import a workflow template first."}
        </p>
      ) : (
        <div className="space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
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
                    {j.outputs.length === 0 ? "—" : j.outputs.map((o) => (o.localPath ? o.localPath.split("/").slice(-2).join("/") : `${o.filename} (${o.note ?? "pending"})`)).join(", ")}
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
          description="Only objects under exchange/ that belong to finished jobs of this device (and are already in your workspace, or belong to failed/cancelled jobs) are deleted. Models and reference inputs are never touched."
          confirmLabel="Delete leftovers"
          confirmVariant="danger"
          onCancel={() => setConfirmJanitor(false)}
          onConfirm={() => janitor(false)}
        />
      )}
    </Card>
  );
}

type Session = {
  sessionId: string;
  channelId: string;
  status: string;
  requestedBy: "operator" | "agent";
  reason: string | null;
  maxMinutes: number;
  maxUsd: number | null;
  estimateUsd: number;
  fitsToday: boolean;
  costPerHr: number | null;
  podId: string | null;
  comfyUiProxyUrl: string | null;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  secondsUsed: number | null;
  usdCharged: number | null;
  stopReason: string | null;
  error: string | null;
};
type SessionLimits = { maxUsdPerDay: number; spentTodayUsd: number; remainingTodayUsd: number; defaultMaxMinutes: number; idleMinutes: number; openSession: Session | null };

const OPEN_STATUSES = new Set(["pending", "approved", "starting", "running", "stopping"]);

function minutesLabel(seconds: number | null): string {
  if (seconds === null) return "—";
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

// Phase 14 slice 2 (owner decision D3): a human approves a SESSION (one pod with caps) here -- the only
// place; approving blocks behind the shared progress pop-up until ComfyUI answers. Inside a running
// session the agent submits jobs freely (slice 3); the watcher terminates on idle / minutes / USD.
function SessionsCard({ ready, activeChannelId }: { ready: boolean; activeChannelId: string | null }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [limits, setLimits] = useState<SessionLimits | null>(null);
  const [maxMinutes, setMaxMinutes] = useState<number | null>(null);
  const [maxUsd, setMaxUsd] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<Session | null>(null);
  const [stopTarget, setStopTarget] = useState<Session | null>(null);
  const op = useOperation();
  const { runBlocking } = op;

  const fetchAll = useCallback(
    () =>
      requestJson<{ sessions: Session[]; limits: SessionLimits }>("/api/media-generation/sessions").then(
        (data) => {
          setSessions(data.sessions);
          setLimits(data.limits);
        },
        (err: unknown) => setError(err instanceof Error ? err.message : "Failed to load sessions")
      ),
    []
  );

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // The open session's live cost changes every second; refresh while one exists.
  const hasOpen = Boolean(limits?.openSession);
  useEffect(() => {
    if (!hasOpen) return;
    const timer = setInterval(() => void fetchAll(), 15_000);
    return () => clearInterval(timer);
  }, [hasOpen, fetchAll]);

  async function request() {
    if (!activeChannelId) return;
    const parsedMaxUsd = maxUsd.trim() ? parseMoney(maxUsd) : null;
    if (maxUsd.trim() && parsedMaxUsd === null) {
      setError("Max USD must be a positive amount like 2.5");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await requestJson("/api/media-generation/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: activeChannelId,
          ...(maxMinutes ? { maxMinutes } : {}),
          ...(maxUsd.trim() ? { maxUsd: parsedMaxUsd } : {}),
        }),
      });
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to request a session");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    const target = approveTarget;
    if (!target) return;
    setApproveTarget(null);
    setError(null);
    try {
      await runBlocking({
        title: "Starting the generation session",
        stage: "Creating the pod",
        track: { channelId: target.channelId, kind: "media_session_start" },
        request: async () => {
          const res = await fetch(`/api/media-generation/sessions/${encodeURIComponent(target.sessionId)}/approve`, { method: "POST" });
          return { res, data: (await res.json()) as { session?: Session; message?: string; error?: string } };
        },
        failureOf: ({ res, data }) => (res.ok ? null : (data.message ?? data.error ?? `Error ${res.status}`)),
        summarize: ({ data }) => (data.session ? `Pod ${data.session.podId} is running at $${data.session.costPerHr ?? "?"}/h` : null),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the session");
    } finally {
      await fetchAll();
    }
  }

  async function stop() {
    const target = stopTarget;
    if (!target) return;
    setStopTarget(null);
    setBusy(true);
    setError(null);
    try {
      await requestJson(`/api/media-generation/sessions/${encodeURIComponent(target.sessionId)}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "stopped by operator" }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop the session");
    } finally {
      setBusy(false);
      await fetchAll();
    }
  }

  async function reject(target: Session) {
    setBusy(true);
    setError(null);
    try {
      await requestJson(`/api/media-generation/sessions/${encodeURIComponent(target.sessionId)}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "rejected by operator" }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reject the session");
    } finally {
      setBusy(false);
      await fetchAll();
    }
  }

  const open = limits?.openSession ?? null;
  const recent = sessions.filter((s) => !OPEN_STATUSES.has(s.status)).slice(0, 8);

  return (
    <Card
      title="Sessions"
      help="A session is one RunPod pod running ComfyUI. Requesting one costs nothing; approving creates the pod (billed per second from that moment) and waits until ComfyUI answers. The pod is terminated when the session is stopped, idle, over its minutes or over its USD cap -- never 'stopped' (that would keep billing its disk)."
    >
      {limits && (
        <p className="text-xs text-zinc-500">
          Spent today ${limits.spentTodayUsd.toFixed(2)} of ${limits.maxUsdPerDay.toFixed(2)} · idle timeout {limits.idleMinutes} min
        </p>
      )}

      {open ? (
        <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3">
          <p className="text-sm text-zinc-200">
            <span className="font-medium">{open.status}</span>
            {" · "}requested by {open.requestedBy}
            {open.reason ? ` · ${open.reason}` : ""}
          </p>
          <p className="text-xs text-zinc-400">
            cap {open.maxMinutes} min{open.maxUsd !== null ? ` / $${open.maxUsd}` : ""} · estimate ${open.estimateUsd.toFixed(2)}
            {open.fitsToday ? "" : " (does not fit today's cap)"}
            {open.podId ? ` · pod ${open.podId}` : ""}
            {open.costPerHr !== null ? ` · $${open.costPerHr}/h` : ""}
            {open.startedAt ? ` · running ${minutesLabel(open.secondsUsed)} ≈ $${(open.usdCharged ?? 0).toFixed(2)}` : ""}
          </p>
          {open.error && <p className="text-xs text-amber-400">{open.error}</p>}
          <div className="flex flex-wrap gap-2">
            {open.status === "pending" && (
              <>
                <button type="button" onClick={() => setApproveTarget(open)} disabled={busy || !ready} className={primaryButton}>
                  Approve and start
                </button>
                <button type="button" onClick={() => reject(open)} disabled={busy} className={secondaryButton}>
                  Reject
                </button>
              </>
            )}
            {["starting", "running", "stopping"].includes(open.status) && (
              <button type="button" onClick={() => setStopTarget(open)} disabled={busy} className={dangerButton}>
                Stop (terminate pod)
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {!activeChannelId ? (
            <p className="text-xs text-zinc-500">Select an active channel to request a session.</p>
          ) : !ready ? (
            <p className="text-xs text-zinc-500">Finish the setup above to request a session.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="block text-xs text-zinc-400">
                Max minutes
                <input type="number" min={1} max={1440} value={maxMinutes ?? limits?.defaultMaxMinutes ?? 60} onChange={(e) => setMaxMinutes(Number(e.target.value))} className={inputClass} />
              </label>
              <label className="block text-xs text-zinc-400">
                Max USD (optional)
                <input type="text" inputMode="decimal" value={maxUsd} onChange={(e) => setMaxUsd(e.target.value)} className={inputClass} placeholder="no cap (e.g. 2.5)" />
              </label>
              <div className="flex items-end">
                <button type="button" onClick={request} disabled={busy} className={primaryButton}>
                  {busy ? "Requesting…" : "Request a session"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-[640px] w-full text-left text-xs text-zinc-400">
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
                  <td className="py-1 pr-3">{s.status}</td>
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
      <OperationOverlay state={op.state} onClose={op.reset} />
      {approveTarget && (
        <ConfirmDialog
          title="Start this generation session?"
          description={`RunPod bills the pod per second from creation (about $${approveTarget.estimateUsd.toFixed(2)} for the full ${approveTarget.maxMinutes} minutes). The pod is terminated automatically when idle, at the cap, or when you stop it.`}
          confirmLabel="Approve and start"
          onCancel={() => setApproveTarget(null)}
          onConfirm={approve}
        />
      )}
      {stopTarget && (
        <ConfirmDialog
          title="Terminate the session's pod now?"
          description="Running jobs are cut off; files already on the volume stay there."
          confirmLabel="Terminate"
          confirmVariant="danger"
          onCancel={() => setStopTarget(null)}
          onConfirm={stop}
        />
      )}
    </Card>
  );
}

function ReadinessBanner({ overview }: { overview: Overview }) {
  if (overview.ready) return <p className="text-xs text-emerald-400">Media generation is configured: request and approve a session below, then submit jobs.</p>;
  return <p className="text-xs text-zinc-500">Not ready yet — missing: {overview.missing.join(", ")}.</p>;
}

function CredentialsCard({ status, onChanged }: { status: CredentialsStatus; onChanged: () => Promise<void> }) {
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
          title="Remove the RunPod credentials from this computer?"
          description="Sessions cannot start without them. The per-device key file stays in place."
          confirmLabel="Remove"
          confirmVariant="danger"
          onCancel={() => setConfirmClear(false)}
          onConfirm={clear}
        />
      )}
    </Card>
  );
}

function ComputeCard({ overview, gatewayTraffic, onChanged }: { overview: Overview; gatewayTraffic: GatewayTrafficWindowView[] | undefined; onChanged: () => Promise<void> }) {
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
            <span className="text-sm text-zinc-300">Media gateway (RunPod API, S3 API, ComfyUI)</span>
          </div>
        }
        right={
          <div>
            <GatewayTrafficStats size="lg" window={traffic("runpod_api")} />
            <p className="text-xs text-zinc-500">
              S3: {traffic("runpod_s3")?.totalAttempts ?? 0} · ComfyUI: {traffic("comfyui_api")?.totalAttempts ?? 0} attempts (24h)
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
                      {dc.countryCode ? ` (${dc.countryCode})` : ""}
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
                      {g.estimatedAvailability ? ` · ${g.estimatedAvailability.toLowerCase()} availability` : ""}
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

function VolumeCard({ overview, onChanged }: { overview: Overview; onChanged: () => Promise<void> }) {
  const { settings, credentials } = overview;
  const [volumes, setVolumes] = useState<Volume[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState(settings.networkVolumeId ?? "");
  const [newName, setNewName] = useState("models");
  const [newSize, setNewSize] = useState(150);
  const [confirmCreate, setConfirmCreate] = useState(false);

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

  const selectedVolume = volumes?.find((v) => v.id === selected);
  const monthly = (gb: number) => (gb * NETWORK_VOLUME_USD_PER_GB_MONTH).toFixed(2);

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
              <div className="mt-3 border-t border-zinc-800 pt-3">
                <p className="mb-2 text-xs text-zinc-400">Create a new volume in {settings.datacenterId ?? "the chosen datacenter (set it under Compute first)"}:</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} className={inputClass} placeholder="name" />
                  <input type="number" min={10} max={4000} value={newSize} onChange={(e) => setNewSize(Number(e.target.value))} className={inputClass} />
                  <button type="button" onClick={() => setConfirmCreate(true)} disabled={busy || !settings.datacenterId || !newName.trim() || newSize < 10} className={secondaryButton}>
                    Create (${monthly(newSize)}/month)
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
          description={`RunPod bills about $${monthly(newSize)} per month for it from now until you delete it in the RunPod console.`}
          confirmLabel="Create volume"
          onCancel={() => setConfirmCreate(false)}
          onConfirm={create}
        />
      )}
    </Card>
  );
}

function LimitsCard({ settings, onChanged }: { settings: Settings; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState({
    defaultMaxMinutes: settings.defaultMaxMinutes,
    idleMinutes: settings.idleMinutes,
    watchIntervalSeconds: settings.watchIntervalSeconds,
  });
  // The daily cap is money: a controlled text field (see parseMoney), not a native number input.
  const [maxUsdPerDayText, setMaxUsdPerDayText] = useState(String(settings.maxUsdPerDay));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setDraft({
      defaultMaxMinutes: settings.defaultMaxMinutes,
      idleMinutes: settings.idleMinutes,
      watchIntervalSeconds: settings.watchIntervalSeconds,
    });
    setMaxUsdPerDayText(String(settings.maxUsdPerDay));
  }, [settings.maxUsdPerDay, settings.defaultMaxMinutes, settings.idleMinutes, settings.watchIntervalSeconds]);

  async function save() {
    const maxUsdPerDay = parseMoney(maxUsdPerDayText);
    if (maxUsdPerDay === null) {
      setError("Max USD per day must be a positive amount like 10 or 2.5");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/media-generation/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...draft, maxUsdPerDay }) });
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
      {label}
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={1}
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: Number(e.target.value) })}
        className={inputClass}
      />
    </label>
  );

  return (
    <Card
      title="Limits"
      help="Daily spend cap across sessions; the default length of a session request; how long a running session may sit without jobs before its pod is terminated; and how often the watcher checks (at least every 15 seconds)."
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-xs text-zinc-400">
          Max USD per day
          <input type="text" inputMode="decimal" value={maxUsdPerDayText} onChange={(e) => setMaxUsdPerDayText(e.target.value)} className={inputClass} placeholder="e.g. 10" />
        </label>
        {field("Default session length (minutes)", "defaultMaxMinutes", { min: 1, max: 1440 })}
        {field("Idle timeout (minutes)", "idleMinutes", { min: 1, max: 1440 })}
        {field("Watch interval (seconds)", "watchIntervalSeconds", { min: 15, max: 3600 })}
      </div>
      <button type="button" onClick={save} disabled={busy} className={primaryButton}>
        {busy ? "Saving…" : "Save limits"}
      </button>
      {notice && <p className="text-xs text-emerald-400">{notice}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </Card>
  );
}
