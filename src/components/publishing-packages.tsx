"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { assignPublishDates, estimateUploadUnits, isDeferredPublishAt, publishInstant } from "@/lib/publishing/publish-dates";
import { uploadTagsSummary, type PublishingSettings } from "@/lib/publishing/settings";
import { formatDisplayDateUtc, parseDisplayDate } from "@/lib/shared-formatting";
import { TAGS_MAX_CHARACTERS } from "@/lib/youtube-video-fields";
import { errorText, type UiTextKey } from "@/lib/ui-text";
import { ConfirmDialog } from "./confirm-dialog";
import { LoadingIndicator } from "./operation-progress";
import { PublishingNewPackage } from "./publishing-new-package";
import { PublishingUploads } from "./publishing-uploads";
import { parseQuotaBlock, QuotaBlockDialog, type QuotaBlock } from "./quota-block-dialog";
import { useUiText } from "./ui-text-provider";
import { useUtcLocalHint } from "./utc-time-field";
import { formatBytes } from "./volume-usage-bar";

type Problem = { code: string; params?: Record<string, string | number> };
type PackageRow = {
  manifestPath: string;
  video: string | null;
  title: string | null;
  plannedPublishDate: string | null;
  thumbnailPath: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  state: "not_ready" | "ready" | "uploaded_private" | "scheduled" | "published" | "uploaded_unknown";
  problems: Problem[];
  youtube: { videoId: string } | null;
  manifestSha256: string | null;
  pkg: { defaultLanguage: string; defaultAudioLanguage: string; tags: string[] } | null;
};
type ScanResult = { status: "no_workspace" } | { status: "workspace_unavailable"; reason: string } | { status: "ok"; packages: PackageRow[] };

const STATE_STYLE: Record<PackageRow["state"], string> = {
  not_ready: "bg-red-950/50 text-red-300",
  ready: "bg-emerald-950/50 text-emerald-300",
  uploaded_private: "bg-zinc-800 text-zinc-300",
  scheduled: "bg-indigo-950/60 text-indigo-200",
  published: "bg-zinc-800 text-zinc-400",
  uploaded_unknown: "bg-amber-950/40 text-amber-200",
};

/** The planned day at the channel's UTC publish time, with the owner's own time for that day. */
function PlannedTime({ date, publishTimeUtc }: { date: string | null; publishTimeUtc: string | null }) {
  const { t } = useUiText();
  const on = date ? new Date(`${date}T12:00:00Z`) : undefined;
  const hint = useUtcLocalHint(publishTimeUtc ?? "", { on });
  if (!date) return <span className="text-zinc-500">{t("publishingPackages.noDate")}</span>;
  return (
    <span>
      {publishTimeUtc ? t("publishingPackages.planned", { date: formatDisplayDateUtc(`${date}T00:00:00Z`), time: publishTimeUtc }) : formatDisplayDateUtc(`${date}T00:00:00Z`)}
      {hint && (
        <span className="ml-1 text-zinc-500" title={hint.title}>
          {hint.text}
        </span>
      )}
    </span>
  );
}

/**
 * BL-182 stage 2 (FO-REQ-0023 §4 B1): the channel's release packages under `04 Videos/`, each with its state -- not ready (and
 * why) / ready / uploaded private / scheduled / published -- in the order they are planned. Read-only for now: the upload and
 * its approval screen come next. The planned time is the package's day at the channel's publish time (UTC, owner msgs
 * 2725/2727). Loaded when the tab is shown and on «Обновить»; reading the folder makes no YouTube call.
 */
export function PublishingPackages({ channelId, visible }: { channelId: string | null; visible: boolean }) {
  const { t, formatNumber } = useUiText();
  const [result, setResult] = useState<ScanResult | null>(null);
  const [settings, setSettings] = useState<PublishingSettings | null>(null);
  const [settingsConflicted, setSettingsConflicted] = useState(false);
  const [takenDays, setTakenDays] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  /** The date text the owner typed per package (DD.MM.YYYY, "" = no date); absent = the suggested date. */
  const [typedDates, setTypedDates] = useState<Record<string, string>>({});
  const [approving, setApproving] = useState(false);
  const [sending, setSending] = useState(false);
  const [quotaBlock, setQuotaBlock] = useState<QuotaBlock | null>(null);
  const [uploadsKey, setUploadsKey] = useState(0);
  /** BL-192: «Новый пакет» is open. */
  const [composing, setComposing] = useState(false);

  const load = useCallback(async () => {
    if (!channelId) return;
    setLoading(true);
    try {
      const base = `/api/channels/${encodeURIComponent(channelId)}`;
      const [packagesRes, settingsRes, calendarRes] = await Promise.all([fetch(`${base}/publishing/packages`), fetch(`${base}/publishing-settings`), fetch(`${base}/publishing/calendar`)]);
      const data = await packagesRes.json();
      if (!packagesRes.ok) throw new Error(errorText(t, data, t("publishingPackages.loadFailed")));
      setResult(data);
      if (settingsRes.ok) {
        const view = (await settingsRes.json()) as { settings: PublishingSettings; conflictedFields: string[] };
        setSettings(view.settings);
        setSettingsConflicted(view.conflictedFields.length > 0);
      }
      if (calendarRes.ok) {
        const calendar = (await calendarRes.json()) as { entries?: Array<{ kind: string; at: string | null }> };
        setTakenDays(new Set((calendar.entries ?? []).filter((e) => (e.kind === "published" || e.kind === "scheduled") && e.at).map((e) => (e.at as string).slice(0, 10))));
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("publishingPackages.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [channelId, t]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const packages = useMemo(() => (result?.status === "ok" ? result.packages : []), [result]);
  const chosen = packages.filter((p) => selected.includes(p.manifestPath) && p.state === "ready");
  // The suggested dates (FO-REQ-0023 §4 B3): planned date at the channel's UTC time, the next free day when taken or too soon.
  const suggested = useMemo(
    () =>
      settings
        ? assignPublishDates({ selected: chosen.map((p) => ({ key: p.manifestPath, plannedDate: p.plannedPublishDate })), takenDays, publishTimeUtc: settings.publishTimeUtc, now: new Date() })
        : new Map<string, string | null>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed when the selection, the taken days or the time change
    [settings, takenDays, selected.join("|"), packages]
  );
  /** The date of a chosen package: the typed one when the owner typed, else the suggestion. null = no date; undefined = invalid. */
  const dateOf = (p: PackageRow): string | null | undefined => {
    const typed = typedDates[p.manifestPath];
    if (typed === undefined) return suggested.get(p.manifestPath) ?? null;
    if (typed.trim() === "") return null;
    const iso = parseDisplayDate(typed);
    if (!iso || !settings) return undefined;
    const day = iso.slice(0, 10);
    return Date.parse(publishInstant(day, settings.publishTimeUtc)) > Date.now() + 15 * 60_000 ? day : undefined;
  };
  const datesValid = chosen.every((p) => dateOf(p) !== undefined);

  async function approve(acknowledgeUnknownQuota = false) {
    if (!channelId || !settings) return;
    setSending(true);
    setError(null);
    try {
      const items = chosen.map((p) => {
        const day = dateOf(p);
        return { manifestPath: p.manifestPath, manifestSha256: p.manifestSha256 ?? "", publishAt: day ? publishInstant(day, settings.publishTimeUtc) : null };
      });
      const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/publishing/uploads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items, shownSettings: settings, ...(acknowledgeUnknownQuota ? { acknowledgeUnknownQuota: true } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) {
        const quota = parseQuotaBlock(data);
        if (quota) {
          setApproving(false);
          setQuotaBlock(quota);
          return;
        }
        throw new Error(errorText(t, data, t("publishingApproval.failed")));
      }
      setApproving(false);
      setSelected([]);
      setTypedDates({});
      setUploadsKey((k) => k + 1);
      await load();
    } catch (e) {
      setApproving(false);
      setError(e instanceof Error ? e.message : t("publishingApproval.failed"));
    } finally {
      setSending(false);
    }
  }

  if (!channelId) return null;
  const counts = {
    total: packages.length,
    ready: packages.filter((p) => p.state === "ready").length,
    notReady: packages.filter((p) => p.state === "not_ready").length,
    uploaded: packages.filter((p) => p.youtube !== null).length,
  };
  const problemText = (problem: Problem) => t(`publishingPackages.problem.${problem.code}` as UiTextKey, problem.params ?? {});
  const duration = (seconds: number) => t("duration.hoursMinutes", { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) });

  const toggle = (path: string) => setSelected((prev) => (prev.includes(path) ? prev.filter((x) => x !== path) : [...prev, path]));
  const readyPaths = packages.filter((p) => p.state === "ready").map((p) => p.manifestPath);
  // The same estimate the server checks the quota with (publish-dates.ts).
  const estimatedUnits = chosen.reduce((sum, p) => {
    const day = dateOf(p);
    const publishAt = day && settings ? publishInstant(day, settings.publishTimeUtc) : null;
    return sum + estimateUploadUnits({ playlist: Boolean(settings?.playlistId), deferredPublishAt: isDeferredPublishAt(publishAt, new Date()) });
  }, 0);

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-medium text-zinc-100">{t("publishingPackages.title")}</h3>
          <p className="mt-1 max-w-3xl text-xs text-zinc-400">{t("publishingPackages.intro")}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          {result?.status === "ok" && (
            <button type="button" onClick={() => setComposing(true)} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500">
              {t("publishingNewPackage.open")}
            </button>
          )}
          <button type="button" onClick={() => void load()} disabled={loading} className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700 disabled:opacity-50">
            {t("publishingPackages.refresh")}
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}
      {!result && !error && <LoadingIndicator className="text-xs text-zinc-400" />}
      {result?.status === "no_workspace" && <p className="text-xs text-amber-200">{t("publishingPackages.noWorkspace")}</p>}
      {result?.status === "workspace_unavailable" && <p className="text-xs text-amber-200">{t("publishingPackages.workspaceUnavailable", { reason: result.reason })}</p>}
      {result?.status === "ok" && packages.length === 0 && <p className="text-xs text-zinc-400">{t("publishingPackages.empty")}</p>}
      {settingsConflicted && <p className="rounded-lg border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200">{t("publishingSettings.differsBetweenComputers")}</p>}
      {packages.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-zinc-400">{t("publishingPackages.summary", counts)}</p>
            {readyPaths.length > 0 && (
              <button type="button" onClick={() => setSelected(selected.length > 0 ? [] : readyPaths)} className="text-xs text-zinc-400 underline hover:text-zinc-200">
                {selected.length > 0 ? t("publishingPackages.clearSelection") : t("publishingPackages.selectAllReady")}
              </button>
            )}
          </div>
          <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
            {packages.map((p) => {
              const isChosen = selected.includes(p.manifestPath) && p.state === "ready";
              const day = isChosen ? dateOf(p) : null;
              const typed = typedDates[p.manifestPath];
              return (
                <li key={p.manifestPath} className="flex gap-3 px-3 py-2">
                  <div className="flex w-5 shrink-0 items-start pt-1">
                    {p.state === "ready" && (
                      <input type="checkbox" checked={isChosen} onChange={() => toggle(p.manifestPath)} aria-label={t("publishingPackages.select", { video: p.video ?? p.manifestPath })} />
                    )}
                  </div>
                  <div className="h-[54px] w-24 shrink-0 overflow-hidden rounded bg-zinc-800">
                    {p.thumbnailPath && (
                      // eslint-disable-next-line @next/next/no-img-element -- a local, session-checked image route, not a static asset
                      <img
                        src={`/api/channels/${encodeURIComponent(channelId)}/publishing/packages/thumbnail?path=${encodeURIComponent(p.thumbnailPath)}`}
                        alt={t("publishingPackages.thumbnailAlt", { video: p.video ?? "" })}
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-zinc-500">{p.video ?? p.manifestPath}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[11px] ${STATE_STYLE[p.state]}`}>{t(`publishingPackages.state.${p.state}` as UiTextKey)}</span>
                      {p.youtube && (
                        <a href={`https://www.youtube.com/watch?v=${encodeURIComponent(p.youtube.videoId)}`} target="_blank" rel="noreferrer" className="text-xs text-zinc-400 underline hover:text-zinc-200">
                          {t("publishingPackages.openOnYoutube")}
                        </a>
                      )}
                    </div>
                    {p.title && <p className="truncate text-zinc-100">{p.title}</p>}
                    <p className="text-xs text-zinc-400">
                      <PlannedTime date={isChosen ? (day ?? null) : p.plannedPublishDate} publishTimeUtc={settings?.publishTimeUtc ?? null} />
                      {p.durationSeconds !== null && <span> · {duration(p.durationSeconds)}</span>}
                      {p.sizeBytes !== null && <span> · {formatBytes(t, formatNumber, p.sizeBytes)}</span>}
                    </p>
                    {isChosen && (
                      <label className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                        {t("publishingPackages.dateLabel")}
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder={t("publishingPackages.datePlaceholder")}
                          value={typed ?? (day ? formatDisplayDateUtc(`${day}T00:00:00Z`) : "")}
                          onChange={(e) => setTypedDates((prev) => ({ ...prev, [p.manifestPath]: e.target.value }))}
                          className={`w-28 rounded border bg-zinc-800 px-2 py-1 text-zinc-100 ${day === undefined ? "border-red-700" : "border-zinc-700"}`}
                        />
                        <span className={day === undefined ? "text-red-400" : "text-zinc-500"}>{day === undefined ? t("publishingPackages.dateInvalid") : t("publishingPackages.noDateHint")}</span>
                      </label>
                    )}
                    {p.problems.length > 0 && (
                      <ul className="list-disc space-y-0.5 pl-4 text-xs text-red-300">
                        {p.problems.map((problem, i) => (
                          <li key={i}>{problemText(problem)}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {chosen.length > 0 && (
            <button
              type="button"
              onClick={() => setApproving(true)}
              disabled={!datesValid || !settings || settingsConflicted || sending}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {t("publishingPackages.uploadSelected", { count: chosen.length })}
            </button>
          )}
        </>
      )}

      <PublishingUploads channelId={channelId} visible={visible} refreshKey={uploadsKey} />

      {composing && (
        <PublishingNewPackage
          channelId={channelId}
          onClose={() => setComposing(false)}
          onSaved={() => {
            setComposing(false);
            void load();
          }}
        />
      )}

      {approving && settings && (
        <ConfirmDialog
          title={t("publishingApproval.title", { count: chosen.length })}
          description={t("publishingApproval.description")}
          confirmLabel={t("publishingApproval.confirm")}
          confirmVariant="danger"
          confirmDisabled={sending}
          onCancel={() => setApproving(false)}
          onConfirm={() => void approve()}
        >
          <div className="max-h-[50vh] space-y-3 overflow-y-auto text-xs text-zinc-300">
            <ul className="space-y-1">
              {chosen.map((p) => {
                const day = dateOf(p);
                // FO-MSG-0017 (owner msg 2817): each row's tags as they will be sent, and where they come from (the package's own, or the
                // channel's when the package has none).
                const tags = uploadTagsSummary(p.pkg?.tags ?? [], settings.channelTags ?? []);
                const source =
                  tags.tags.length === 0
                    ? t("publishingApproval.tagsSource.none")
                    : tags.fromPackage > 0
                      ? t("publishingApproval.tagsSource.package")
                      : t("publishingApproval.tagsSource.channel");
                return (
                  <li key={p.manifestPath}>
                    <div className="flex gap-2">
                      <span className="font-mono text-zinc-500">{p.video}</span>
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                      <span className="shrink-0 text-zinc-400">{day ? <PlannedTime date={day} publishTimeUtc={settings.publishTimeUtc} /> : t("publishingApproval.noDate")}</span>
                    </div>
                    <p className={`pl-2 ${tags.characters > TAGS_MAX_CHARACTERS ? "text-red-400" : "text-zinc-500"}`} title={tags.tags.join(", ")}>
                      {t("publishingApproval.rowTags", { count: tags.tags.length, chars: tags.characters, source })}
                    </p>
                  </li>
                );
              })}
            </ul>
            <div className="rounded border border-zinc-800 p-2">
              <p className="mb-1 font-medium text-zinc-200">{t("publishingApproval.settings")}</p>
              <p>
                {t("publishingSettings.field.categoryId")}: {t(`publishingSettings.category.${settings.categoryId}` as UiTextKey)} · {t("publishingSettings.field.containsSyntheticMedia")}:{" "}
                {settings.containsSyntheticMedia ? t("publishingApproval.on") : t("publishingApproval.off")} · {t("publishingSettings.field.madeForKids")}:{" "}
                {settings.madeForKids ? t("publishingApproval.on") : t("publishingApproval.off")} · {t("publishingSettings.field.license")}: {t(`publishingSettings.license.${settings.license}` as UiTextKey)} ·{" "}
                {t("publishingSettings.field.embeddable")}: {settings.embeddable ? t("publishingApproval.on") : t("publishingApproval.off")} · {t("publishingSettings.field.notifySubscribers")}:{" "}
                {settings.notifySubscribers ? t("publishingApproval.on") : t("publishingApproval.off")} · {t("publishingSettings.field.playlistId")}: {settings.playlistId ?? t("publishingSettings.playlistNone")} ·{" "}
                {t("publishingSettings.field.paidProductPlacement")}: {settings.paidProductPlacement ? t("publishingApproval.on") : t("publishingApproval.off")}
                {/* ui-text-ignore: the channel's own tags (data) */}
                {(settings.channelTags ?? []).length > 0 ? ` · ${t("publishingApproval.channelTags", { tags: (settings.channelTags ?? []).join(", ") })}` : ""}
              </p>
              {chosen[0]?.pkg && <p className="mt-1">{t("publishingApproval.languages", { language: chosen[0].pkg.defaultLanguage, audio: chosen[0].pkg.defaultAudioLanguage })}</p>}
            </div>
            <p className="text-zinc-400">{t("publishingApproval.quota", { units: estimatedUnits })}</p>
            <p className="text-zinc-400">{t("publishingApproval.liveWrites")}</p>
          </div>
        </ConfirmDialog>
      )}
      {quotaBlock && (
        <QuotaBlockDialog
          block={quotaBlock}
          // ui-text-ignore: a wording selector the dialog compares against, not display text here
          noun="batch"
          onClose={() => setQuotaBlock(null)}
          onRunAnyway={
            quotaBlock.code === "quota_unknown"
              ? () => {
                  setQuotaBlock(null);
                  void approve(true);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
