"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { UiTextKey } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import {
  buildGeminiRequest,
  catalogEstimateUsd,
  GEMINI_FORM_DURATIONS,
  GEMINI_FORM_IMAGE_ASPECTS,
  GEMINI_FORM_VIDEO_ASPECTS,
  type GeminiCatalogModel,
  type GeminiFormProblem,
  type GeminiFormState,
  type GeminiRequest,
} from "./gemini-media-create-request";
import { InfoTooltip } from "./info-tooltip";
import { useT } from "./ui-text-provider";

// BL-188 stage 4 (SHARED_MEDIA_JOBS_PLAN.md §5 item 4, owner msg 2806 Q3): the owner launches ONE Gemini image or video from
// Media's Images / Video tab, on this computer or on another one. Here: the same create the Factory Operator's tool runs (this
// computer's switch, key and limits), with an estimate first. Elsewhere: a command to that computer, which checks its own switch,
// key and limits and answers in the job list below (a run not taken within 15 minutes expires there and is never charged).

type Status = { enabled: boolean; keyConfigured: boolean; keyStatus: "ok" | "payment_required" | null; models: GeminiCatalogModel[] };
type Device = { deviceId: string; hostName: string | null; own: boolean; stale: boolean };
type DryRun = { dryRun: true; estimateUsd: number; allowed: boolean; refusal: { code: string; message: string } | null };

/** Media's job list refreshes when this event fires (a job was just created or sent). */
export const MEDIA_JOBS_CHANGED_EVENT = "media-jobs:changed";

const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none";
const primaryButton = "rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50";
const secondaryButton = "rounded-md border border-zinc-700 bg-zinc-800 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50";
const THIS_COMPUTER = "";

const PROBLEM_TEXT: Record<GeminiFormProblem, UiTextKey> = {
  model: "media.gemini.problem.model",
  prompt: "media.gemini.problem.prompt",
  size: "media.gemini.problem.size",
  aspectRatio: "media.gemini.problem.aspectRatio",
  resolution: "media.gemini.problem.resolution",
  duration: "media.gemini.problem.duration",
  path: "media.gemini.problem.path",
  references: "media.gemini.problem.references",
  frames: "media.gemini.problem.frames",
  lastFrame: "media.gemini.problem.lastFrame",
  storyboard: "media.gemini.problem.storyboard",
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  // ui-text-ignore: technical fallback naming the endpoint, shown only when the server sends no message of its own
  if (!res.ok) throw new Error((data as { message?: string }).message ?? `Request to ${url} failed (${res.status})`);
  return data as T;
}

const usd = (value: number) => `$${value.toFixed(value < 1 ? 3 : 2)}`;

function emptyForm(kind: "image" | "video", models: readonly GeminiCatalogModel[]): GeminiFormState {
  const first = models.find((m) => m.kind === kind && !(m.kind === "video" && m.retiresOn)) ?? models.find((m) => m.kind === kind);
  return {
    model: first?.model ?? "",
    prompt: "",
    size: first?.kind === "image" ? (first.sizes[0] ?? "1K") : "1K",
    aspectRatio: kind === "image" ? "1:1" : "16:9",
    referenceImages: "",
    resolution: first?.kind === "video" ? (first.resolutions[0] ?? "720p") : "720p",
    durationSeconds: 8,
    firstFrame: "",
    lastFrame: "",
    storyboardId: "",
    segmentId: "",
  };
}

export function GeminiCreateCard({ activeChannelId, kind }: { activeChannelId: string | null; kind: "image" | "video" }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [target, setTarget] = useState(THIS_COMPUTER);
  const [form, setForm] = useState<GeminiFormState | null>(null);
  const [estimate, setEstimate] = useState<DryRun | null>(null);
  const [confirming, setConfirming] = useState<GeminiRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    () =>
      Promise.all([requestJson<Status>("/api/gemini-media/status"), requestJson<{ devices: Device[] }>(`/api/media-jobs?limit=1&kind=${kind}`)]).then(
        ([s, pool]) => {
          setStatus(s);
          setDevices(pool.devices.filter((d) => !d.own));
          setForm((current) => current ?? emptyForm(kind, s.models));
        },
        (err: unknown) => setError(err instanceof Error ? err.message : t("media.gemini.loadFailed"))
      ),
    [kind, t]
  );

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const models = useMemo(() => (status?.models ?? []).filter((m) => m.kind === kind), [status, kind]);
  const spec = models.find((m) => m.model === form?.model) ?? null;
  const peer = devices.find((d) => d.deviceId === target) ?? null;
  const remote = target !== THIS_COMPUTER && peer !== null;
  const hereBlocked = !remote && status !== null && (!status.enabled || !status.keyConfigured);

  const update = (patch: Partial<GeminiFormState>) => {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setEstimate(null);
    setNotice(null);
    setError(null);
  };

  function built(): GeminiRequest | null {
    if (!form) return null;
    const result = buildGeminiRequest(kind, form, models);
    if (!result.ok) {
      setError(t(PROBLEM_TEXT[result.problem]));
      return null;
    }
    return result.request;
  }

  async function checkEstimate() {
    const request = built();
    if (!request) return;
    setBusy(true);
    setError(null);
    try {
      setEstimate(await requestJson<DryRun>("/api/gemini-media/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, dryRun: true }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.gemini.submitFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function launch(request: GeminiRequest) {
    setConfirming(null);
    setBusy(true);
    setError(null);
    try {
      if (remote && peer) {
        await requestJson("/api/media-jobs/commands", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "create_job", targetDeviceId: peer.deviceId, source: "gemini", gemini: request }),
        });
        setNotice(t("media.gemini.sent", { name: peer.hostName ?? t("media.pool.unnamedDevice") }));
      } else {
        await requestJson("/api/gemini-media/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
        setNotice(t("media.gemini.created"));
      }
      setEstimate(null);
      window.dispatchEvent(new Event(MEDIA_JOBS_CHANGED_EVENT));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("media.gemini.submitFailed"));
    } finally {
      setBusy(false);
    }
  }

  const title = t(kind === "image" ? "media.gemini.titleImage" : "media.gemini.titleVideo");
  const pendingEstimate = confirming ? (remote ? catalogEstimateUsd(confirming, models) : (estimate?.estimateUsd ?? catalogEstimateUsd(confirming, models))) : null;

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          {title}
          <InfoTooltip>{t("media.gemini.help")}</InfoTooltip>
        </h3>
        <button type="button" onClick={() => setOpen((v) => !v)} className={secondaryButton} aria-expanded={open}>
          {t(open ? "media.gemini.hide" : "media.gemini.show")}
        </button>
      </div>
      {open && !activeChannelId && <p className="text-xs text-zinc-500">{t("media.gemini.noChannel")}</p>}
      {open && activeChannelId && form && status && (
        <div className="space-y-3 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-xs text-zinc-400">{t("media.gemini.computer")}</span>
              <select value={remote ? target : THIS_COMPUTER} onChange={(e) => {
                  setTarget(e.target.value);
                  setEstimate(null);
                  setNotice(null);
                }} className={inputClass}>
                <option value={THIS_COMPUTER}>{t("media.gemini.thisComputer")}</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {t(d.stale ? "media.gemini.peerStale" : "media.gemini.peer", { name: d.hostName ?? t("media.pool.unnamedDevice") })}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-zinc-400">{t("media.gemini.model")}</span>
              <select
                value={form.model}
                onChange={(e) => {
                  const next = models.find((m) => m.model === e.target.value);
                  update({
                    model: e.target.value,
                    ...(next?.kind === "image" && !next.sizes.includes(form.size) ? { size: next.sizes[0] ?? "1K" } : {}),
                    ...(next?.kind === "video" && !next.resolutions.includes(form.resolution) ? { resolution: next.resolutions[0] ?? "720p" } : {}),
                  });
                }}
                className={inputClass}
              >
                {models.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.kind === "video" && m.retiresOn ? t("media.gemini.modelRetires", { label: m.label, date: m.retiresOn }) : m.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {remote ? (
            <p className="text-xs text-zinc-400">{t("media.gemini.peerChecks", { name: peer?.hostName ?? t("media.pool.unnamedDevice") })}</p>
          ) : hereBlocked ? (
            <p className="text-xs text-amber-300">{t(status.enabled ? "media.gemini.keyMissingHere" : "media.gemini.disabledHere")}</p>
          ) : null}
          <label className="block space-y-1">
            <span className="text-xs text-zinc-400">{t("media.gemini.prompt")}</span>
            <textarea value={form.prompt} onChange={(e) => update({ prompt: e.target.value })} rows={4} maxLength={10_000} placeholder={t("media.gemini.promptPlaceholder")} className={inputClass} />
            <span className="block text-xs text-zinc-500">{t("media.gemini.oneResult")}</span>
          </label>
          {spec?.kind === "image" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{t("media.gemini.size")}</span>
                <select value={form.size} onChange={(e) => update({ size: e.target.value })} className={inputClass}>
                  {spec.sizes.map((size) => (
                    <option key={size} value={size}>
                      {t("media.gemini.sizeOption", { size, price: usd(spec.usdPerImage[size] ?? 0) })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{t("media.gemini.aspect")}</span>
                <select value={form.aspectRatio} onChange={(e) => update({ aspectRatio: e.target.value })} className={inputClass}>
                  {GEMINI_FORM_IMAGE_ASPECTS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {spec?.kind === "video" && (
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{t("media.gemini.resolution")}</span>
                <select value={form.resolution} onChange={(e) => update({ resolution: e.target.value })} className={inputClass}>
                  {spec.resolutions.map((r) => (
                    <option key={r} value={r}>
                      {t("media.gemini.resolutionOption", { resolution: r, price: usd(spec.usdPerSecond[r] ?? 0) })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{t("media.gemini.aspect")}</span>
                <select value={form.aspectRatio} onChange={(e) => update({ aspectRatio: e.target.value })} className={inputClass}>
                  {GEMINI_FORM_VIDEO_ASPECTS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{t("media.gemini.duration")}</span>
                <select value={String(form.durationSeconds)} onChange={(e) => update({ durationSeconds: Number(e.target.value) })} className={inputClass}>
                  {GEMINI_FORM_DURATIONS.map((d) => (
                    <option key={d} value={String(d)}>
                      {t("media.gemini.durationOption", { seconds: d })}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {spec?.kind === "video" && spec.frames && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{t("media.gemini.firstFrame")}</span>
                <input type="text" value={form.firstFrame} onChange={(e) => update({ firstFrame: e.target.value })} placeholder={t("media.gemini.pathPlaceholder")} className={inputClass} />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{t("media.gemini.lastFrame")}</span>
                <input type="text" value={form.lastFrame} onChange={(e) => update({ lastFrame: e.target.value })} placeholder={t("media.gemini.pathPlaceholder")} className={inputClass} />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{t("media.gemini.storyboard")}</span>
                <input type="text" value={form.storyboardId} onChange={(e) => update({ storyboardId: e.target.value })} className={inputClass} />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-zinc-400">{t("media.gemini.segment")}</span>
                <input type="text" value={form.segmentId} onChange={(e) => update({ segmentId: e.target.value })} className={inputClass} />
              </label>
              <p className="text-xs text-zinc-500 sm:col-span-2">{t("media.gemini.framesHint")}</p>
            </div>
          )}
          {(spec?.kind === "image" || (spec?.kind === "video" && spec.referenceImages)) && (
            <label className="block space-y-1">
              <span className="text-xs text-zinc-400">{t("media.gemini.references")}</span>
              <textarea value={form.referenceImages} onChange={(e) => update({ referenceImages: e.target.value })} rows={2} placeholder={t("media.gemini.pathPlaceholder")} className={inputClass} />
              <span className="block text-xs text-zinc-500">{t(kind === "image" ? "media.gemini.referencesHintImage" : "media.gemini.referencesHintVideo")}</span>
            </label>
          )}
          {estimate && (
            <p className={`text-xs ${estimate.allowed ? "text-emerald-400" : "text-amber-300"}`}>
              {estimate.allowed ? t("media.gemini.estimateOk", { usd: usd(estimate.estimateUsd) }) : t("media.gemini.estimateRefused", { usd: usd(estimate.estimateUsd), reason: estimate.refusal?.message ?? "—" })}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!remote && (
              <button type="button" onClick={() => void checkEstimate()} disabled={busy} className={secondaryButton}>
                {t("media.gemini.estimateButton")}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const request = built();
                if (request) setConfirming(request);
              }}
              disabled={busy || hereBlocked || (!remote && estimate !== null && !estimate.allowed)}
              className={primaryButton}
            >
              {t("media.gemini.run")}
            </button>
          </div>
          {notice && <p className="text-xs text-emerald-400">{notice}</p>}
        </div>
      )}
      {open && activeChannelId && !status && !error && <p className="text-xs text-zinc-500">{t("media.gemini.loading")}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {confirming && (
        <ConfirmDialog
          title={t(kind === "image" ? "media.gemini.confirmTitleImage" : "media.gemini.confirmTitleVideo")}
          description={
            remote
              ? t("media.gemini.confirmRemote", { name: peer?.hostName ?? t("media.pool.unnamedDevice") })
              : t("media.gemini.confirmHere")
          }
          confirmLabel={t("media.gemini.confirmRun")}
          onCancel={() => setConfirming(null)}
          onConfirm={() => void launch(confirming)}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-300">
            <dt className="text-zinc-500">{t("media.gemini.model")}</dt>
            <dd>{spec?.label ?? confirming.model}</dd>
            <dt className="text-zinc-500">{t("media.gemini.settings")}</dt>
            <dd>
              {confirming.image
                ? `${confirming.image.size} · ${confirming.image.aspectRatio}`
                : confirming.video
                  ? `${confirming.video.resolution} · ${confirming.video.aspectRatio} · ${t("media.gemini.durationOption", { seconds: confirming.video.durationSeconds })}`
                  : "—"}
            </dd>
            <dt className="text-zinc-500">{t("media.gemini.cost")}</dt>
            <dd>{pendingEstimate !== null ? t(remote ? "media.gemini.costAbout" : "media.gemini.costEstimate", { usd: usd(pendingEstimate) }) : "—"}</dd>
          </dl>
        </ConfirmDialog>
      )}
    </div>
  );
}
