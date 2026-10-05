"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { ConfirmDialog } from "./confirm-dialog";
import { GatewayTrafficStats, type GatewayTrafficWindowView } from "./gateway-traffic-stats";
import { InfoTooltip } from "./info-tooltip";
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

const VOLUME_USD_PER_GB_MONTH = 0.07;

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { message?: string }).message ?? `Request to ${url} failed (${res.status})`);
  return data as T;
}

const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none";
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

export function MediaGenerationSettings() {
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
    </div>
  );
}

function ReadinessBanner({ overview }: { overview: Overview }) {
  if (overview.ready) return <p className="text-xs text-emerald-400">Media generation is configured. Sessions and jobs arrive in the next slices.</p>;
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
  const monthly = (gb: number) => (gb * VOLUME_USD_PER_GB_MONTH).toFixed(2);

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
    maxUsdPerDay: settings.maxUsdPerDay,
    defaultMaxMinutes: settings.defaultMaxMinutes,
    idleMinutes: settings.idleMinutes,
    watchIntervalSeconds: settings.watchIntervalSeconds,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setDraft({
      maxUsdPerDay: settings.maxUsdPerDay,
      defaultMaxMinutes: settings.defaultMaxMinutes,
      idleMinutes: settings.idleMinutes,
      watchIntervalSeconds: settings.watchIntervalSeconds,
    });
  }, [settings.maxUsdPerDay, settings.defaultMaxMinutes, settings.idleMinutes, settings.watchIntervalSeconds]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await requestJson("/api/media-generation/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
      setNotice("Saved.");
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, key: keyof typeof draft, props: { min: number; max: number; step?: number }) => (
    <label className="block text-xs text-zinc-400">
      {label}
      <input
        type="number"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
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
        {field("Max USD per day", "maxUsdPerDay", { min: 0.01, max: 10000, step: 0.5 })}
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
