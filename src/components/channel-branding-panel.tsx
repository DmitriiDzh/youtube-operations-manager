"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { errorText, type UiTextKey } from "@/lib/ui-text";
// The pure file (no server code): the same limits and checks the server uses.
import {
  CHANNEL_BANNER_MIN_HEIGHT,
  CHANNEL_BANNER_MIN_WIDTH,
  CHANNEL_BRANDING_DESCRIPTION_MAX_CHARACTERS,
  CHANNEL_BRANDING_KEYWORDS_MAX_CHARACTERS,
  characterCount,
  checkBannerBytes,
  keywordsFromText,
  serializeKeywords,
  validateDescription,
  validateKeywords,
  type ChannelBrandingField,
  type ChannelBrandingRefusal,
} from "@/lib/channel-branding/draft";
import type { ChannelBrandingGetView, ChannelBrandingLastApply, ChannelBrandingPreview } from "@/lib/channel-branding/contracts";
import { ActionButton, StatusNotice } from "./busy-feedback";
import { ConfirmDialog } from "./confirm-dialog";
import { InfoTooltip } from "./info-tooltip";
import { LoadingIndicator } from "./operation-progress";
import { useT } from "./ui-text-provider";

// BL-223 (docs/roadmap/plans/CHANNEL_BRANDING_PLAN.md §6, ADR 0050): the card «Канал» on «Главная» -- the channel's name and avatar
// (read-only: YouTube allows changing them only in Studio), and its description, keywords and banner: the value on YouTube next to
// the draft, edited by hand (the Factory Operator or the channel's worker may save a draft too), «Сохранить» on this computer,
// «Проверить на YouTube» (1 quota unit), then «Применить» (after a confirmation) -- the only way the draft reaches YouTube.

const cardClass = "space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4";
const inputClass = "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 disabled:opacity-50";
const buttonClass = "rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50";
const primaryClass = "rounded-lg bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-50";
const warnClass = "rounded-lg border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-200";
const liveClass = "whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-1 text-xs text-zinc-400";

const FIELD_KEYS: Record<ChannelBrandingField, UiTextKey> = {
  description: "channelBranding.field.description",
  keywords: "channelBranding.field.keywords",
  banner: "channelBranding.field.banner",
};

const STATUS_KEYS: Record<"new" | "changed" | "unchanged" | "cleared", UiTextKey> = {
  new: "channelBranding.status.new",
  changed: "channelBranding.status.changed",
  unchanged: "channelBranding.status.unchanged",
  cleared: "channelBranding.status.cleared",
};

const FAILURE_KEYS: Record<"read_back_mismatch" | "banner_uploaded_not_set" | "failed", UiTextKey> = {
  read_back_mismatch: "channelBranding.last.mismatch",
  banner_uploaded_not_set: "channelBranding.last.bannerNotSet",
  failed: "channelBranding.last.failed",
};

/** A refusal in the owner's language (the server's message is the agents'). */
function refusalText(t: ReturnType<typeof useT>, refusal: ChannelBrandingRefusal): string {
  return t(`channelBranding.reason.${refusal.reason}` as UiTextKey, {
    max: refusal.field === "description" ? String(CHANNEL_BRANDING_DESCRIPTION_MAX_CHARACTERS) : String(CHANNEL_BRANDING_KEYWORDS_MAX_CHARACTERS),
    width: String(CHANNEL_BANNER_MIN_WIDTH),
    height: String(CHANNEL_BANNER_MIN_HEIGHT),
  });
}

type BannerChoice = { kind: "none" } | { kind: "stored" } | { kind: "file"; file: File; url: string; refusal: ChannelBrandingRefusal | null; size: string | null };

export function ChannelBrandingPanel({ channelId }: { channelId: string }) {
  const t = useT();
  const base = `/api/channels/${encodeURIComponent(channelId)}/channel-branding`;
  const [view, setView] = useState<ChannelBrandingGetView | null>(null);
  const [description, setDescription] = useState("");
  const [keywordsText, setKeywordsText] = useState("");
  const [touched, setTouched] = useState<{ description: boolean; keywords: boolean }>({ description: false, keywords: false });
  const [banner, setBanner] = useState<BannerChoice>({ kind: "none" });
  const [serverRefusals, setServerRefusals] = useState<ChannelBrandingRefusal[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedSignal, setSavedSignal] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<ChannelBrandingPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fill = useCallback((next: ChannelBrandingGetView) => {
    setView(next);
    const draft = next.draft;
    setDescription(draft?.description ?? next.live?.description ?? "");
    setKeywordsText((draft?.keywords ?? next.live?.keywords ?? []).join(", "));
    setTouched({ description: false, keywords: false });
    setBanner(draft?.banner ? { kind: "stored" } : { kind: "none" });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(base);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorText(t, body, t("channelBranding.loadFailed")));
      fill(body as ChannelBrandingGetView);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channelBranding.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [base, fill, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => {
    if (banner.kind === "file") URL.revokeObjectURL(banner.url);
  }, [banner]);

  const draft = view?.draft ?? null;
  const live = view?.live ?? null;
  const keywords = useMemo(() => keywordsFromText(keywordsText), [keywordsText]);
  // A field goes into the draft when the stored draft has it or the owner edited it (never an empty value read from nowhere).
  const includeDescription = touched.description || draft?.description !== undefined;
  const includeKeywords = touched.keywords || draft?.keywords !== undefined;
  const localRefusals = useMemo(() => {
    const out: ChannelBrandingRefusal[] = [];
    if (includeDescription) {
      const checked = validateDescription(description);
      if ("refusal" in checked) out.push(checked.refusal);
    }
    if (includeKeywords) {
      const checked = validateKeywords(keywords);
      if ("refusals" in checked) out.push(...checked.refusals);
    }
    if (banner.kind === "file" && banner.refusal) out.push(banner.refusal);
    return out;
  }, [banner, description, includeDescription, includeKeywords, keywords]);
  const refusals = [...localRefusals, ...serverRefusals.filter((r) => !localRefusals.some((l) => l.field === r.field && l.reason === r.reason))];
  const dirty =
    (touched.description && description !== (draft?.description ?? live?.description ?? "")) ||
    (touched.keywords && serializeKeywords(keywords) !== serializeKeywords(draft?.keywords ?? live?.keywords ?? [])) ||
    banner.kind === "file" ||
    (banner.kind === "none" && draft?.banner !== undefined);

  function changed() {
    setPreview(null);
    setServerRefusals([]);
  }

  async function chooseFile(file: File | null) {
    changed();
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const checked = checkBannerBytes(bytes);
    const url = URL.createObjectURL(file);
    setBanner({ kind: "file", file, url, refusal: "refusal" in checked ? checked.refusal : null, size: "meta" in checked ? `${checked.meta.width}×${checked.meta.height}` : null });
  }

  async function save() {
    setSaving(true);
    setError(null);
    setNotice(null);
    setPreview(null);
    try {
      const fields: Record<string, unknown> = {};
      if (includeDescription) fields.description = description;
      if (includeKeywords) fields.keywords = keywords;
      let init: RequestInit;
      if (banner.kind === "file") {
        const form = new FormData();
        form.set("draft", JSON.stringify(fields));
        form.set("banner", banner.file, banner.file.name);
        init = { method: "PUT", body: form };
      } else {
        init = { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...fields, keepBanner: banner.kind === "stored" }) };
      }
      const response = await fetch(base, init);
      const body = (await response.json().catch(() => null)) as { details?: { refused?: ChannelBrandingRefusal[] } } | null;
      if (!response.ok) {
        const refused = body?.details?.refused ?? [];
        if (refused.length > 0) {
          setServerRefusals(refused);
          setError(t("channelBranding.refused"));
        } else {
          setError(errorText(t, body, t("channelBranding.saveFailed"), { showErrorField: false }));
        }
        return;
      }
      setServerRefusals([]);
      setNotice(t("channelBranding.saved"));
      setSavedSignal((n) => n + 1);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channelBranding.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function runPreview() {
    setPreviewing(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${base}/preview`);
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorText(t, body, t("channelBranding.previewFailed")));
      setPreview(body as ChannelBrandingPreview);
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : t("channelBranding.previewFailed"));
    } finally {
      setPreviewing(false);
    }
  }

  async function apply() {
    setApplying(true);
    setError(null);
    setNotice(null);
    try {
      // Bound to the draft this preview was computed from (a draft saved since is refused).
      const response = await fetch(`${base}/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draftVersion: preview?.draftVersion ?? "" }) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorText(t, body, t("channelBranding.applyFailed")));
      const result = body as ChannelBrandingLastApply;
      if (result.ok) setNotice(result.writes === 0 ? t("channelBranding.appliedNothing") : t("channelBranding.applied", { fields: result.fields.map((f) => t(FIELD_KEYS[f])).join(", ") }));
      else setError(t("channelBranding.last.mismatch", { at: new Date(result.at).toLocaleString(t.language), detail: result.detail }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("channelBranding.applyFailed"));
    } finally {
      setApplying(false);
      setConfirming(false);
      setPreview(null);
      await load();
    }
  }

  const last = view?.lastApply ?? null;
  const lastAt = last ? new Date(last.at).toLocaleString(t.language) : "";
  const busy = saving || previewing || applying;
  const canApply = preview !== null && preview.quota.writes > 0 && !dirty && !applying;
  const descriptionLength = characterCount(description.replace(/\r\n/g, "\n"));
  const keywordsLength = characterCount(serializeKeywords(keywords));
  const studioUrl = `https://studio.youtube.com/channel/${encodeURIComponent(channelId)}/editing/profile`;
  const storedBannerSrc = draft?.banner ? `${base}/banner?v=${draft.banner.sha256.slice(0, 12)}` : null;

  return (
    <div className={cardClass}>
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
          {t("channelBranding.title")}
          <InfoTooltip>{t("channelBranding.info")}</InfoTooltip>
        </h3>
        <p className="mt-1 text-xs text-zinc-400">{t("channelBranding.intro")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {live?.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- the channel's avatar from YouTube
          <img src={live.avatarUrl} alt="" className="h-12 w-12 shrink-0 rounded-full" />
        ) : (
          <div className="h-12 w-12 shrink-0 rounded-full bg-zinc-800" />
        )}
        <div className="min-w-0">
          {/* ui-text-ignore: the channel's name and handle from YouTube (data) */}
          <p className="truncate text-sm font-medium text-zinc-100">{live?.title ?? "—"}{live?.customUrl ? ` · ${live.customUrl}` : ""}</p>
          <p className="text-[11px] text-zinc-500">
            {t("channelBranding.nameAvatarNote")}{" "}
            <a href={studioUrl} target="_blank" rel="noreferrer" className="text-zinc-300 underline hover:text-white">
              {t("channelBranding.openStudio")}
            </a>
          </p>
        </div>
      </div>

      {view?.liveUnavailable && <p className={warnClass}>{t("channelBranding.liveUnavailable", { code: view.liveUnavailable })}</p>}
      {view?.problem && <p className={warnClass}>{t("channelBranding.problem", { problem: view.problem })}</p>}
      {view?.updatedBy && view.updatedAt && (
        <p className="text-[11px] text-zinc-500">
          {t("channelBranding.savedBy", { at: new Date(view.updatedAt).toLocaleString(t.language), by: t(`channelBranding.by.${view.updatedBy}` as UiTextKey) })}
        </p>
      )}
      {last &&
        (last.ok ? (
          <p className="text-xs text-emerald-300">
            {last.writes === 0 ? t("channelBranding.last.nothing", { at: lastAt }) : t("channelBranding.last.ok", { at: lastAt, fields: last.fields.map((f) => t(FIELD_KEYS[f])).join(", ") })}
          </p>
        ) : (
          <p className="text-xs text-amber-300">
            {t(FAILURE_KEYS[last.failure], { at: lastAt, detail: last.detail, error: last.error ?? last.detail })} <span className="font-mono">({last.failure === "read_back_mismatch" ? last.failure : last.detail})</span>
          </p>
        ))}

      <section className="space-y-1">
        <label className="block space-y-1 text-sm text-zinc-400">
          <span>{t("channelBranding.field.description")}</span>
          <textarea
            value={description}
            rows={5}
            onChange={(e) => {
              setDescription(e.target.value);
              setTouched((c) => ({ ...c, description: true }));
              changed();
            }}
            disabled={busy || loading}
            className={inputClass}
          />
        </label>
        <span className={`block text-[11px] ${descriptionLength > CHANNEL_BRANDING_DESCRIPTION_MAX_CHARACTERS ? "text-amber-300" : "text-zinc-500"}`}>
          {t("channelBranding.count", { count: String(descriptionLength), max: String(CHANNEL_BRANDING_DESCRIPTION_MAX_CHARACTERS) })}
        </span>
        {live && <p className={liveClass}>{t("channelBranding.onYoutube", { value: live.description || "—" })}</p>}
      </section>

      <section className="space-y-1">
        <label className="block space-y-1 text-sm text-zinc-400">
          <span>{t("channelBranding.field.keywords")}</span>
          <textarea
            value={keywordsText}
            rows={2}
            onChange={(e) => {
              setKeywordsText(e.target.value);
              setTouched((c) => ({ ...c, keywords: true }));
              changed();
            }}
            disabled={busy || loading}
            className={inputClass}
          />
        </label>
        <span className={`block text-[11px] ${keywordsLength > CHANNEL_BRANDING_KEYWORDS_MAX_CHARACTERS ? "text-amber-300" : "text-zinc-500"}`}>
          {t("channelBranding.keywordsHint", { count: String(keywordsLength), max: String(CHANNEL_BRANDING_KEYWORDS_MAX_CHARACTERS) })}
        </span>
        {live && <p className={liveClass}>{t("channelBranding.onYoutube", { value: live.keywords.join(", ") || "—" })}</p>}
      </section>

      <section className="space-y-2">
        <p className="text-sm text-zinc-400">{t("channelBranding.field.banner")}</p>
        <p className="text-[11px] text-zinc-500">{t("channelBranding.bannerRules", { width: String(CHANNEL_BANNER_MIN_WIDTH), height: String(CHANNEL_BANNER_MIN_HEIGHT) })}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <figure className="space-y-1">
            <figcaption className="text-[11px] text-zinc-500">{t("channelBranding.bannerOnYoutube")}</figcaption>
            {live?.bannerUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- the channel's banner from YouTube
              <img src={live.bannerUrl} alt="" className="aspect-video w-full rounded-md object-cover" />
            ) : (
              <div className="flex aspect-video w-full items-center justify-center rounded-md bg-zinc-800 text-[11px] text-zinc-500">{t("channelBranding.noBanner")}</div>
            )}
          </figure>
          <figure className="space-y-1">
            <figcaption className="text-[11px] text-zinc-500">{t("channelBranding.bannerDraft")}</figcaption>
            {banner.kind === "file" ? (
              // eslint-disable-next-line @next/next/no-img-element -- the image the owner just chose (an object URL)
              <img src={banner.url} alt="" className="aspect-video w-full rounded-md object-cover" />
            ) : banner.kind === "stored" && storedBannerSrc ? (
              // eslint-disable-next-line @next/next/no-img-element -- the draft's banner stored on this computer
              <img src={storedBannerSrc} alt="" className="aspect-video w-full rounded-md object-cover" />
            ) : (
              <div className="flex aspect-video w-full items-center justify-center rounded-md bg-zinc-800 text-[11px] text-zinc-500">{t("channelBranding.noBannerDraft")}</div>
            )}
            {banner.kind === "file" && banner.size && <p className="text-[11px] text-zinc-500">{banner.size}</p>}
            {banner.kind === "stored" && draft?.banner && <p className="text-[11px] text-zinc-500">{`${draft.banner.width}×${draft.banner.height}`}</p>}
          </figure>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className={`${buttonClass} cursor-pointer`}>
            {t("channelBranding.chooseBanner")}
            <input type="file" accept="image/jpeg,image/png" className="hidden" disabled={busy} onChange={(e) => void chooseFile(e.target.files?.[0] ?? null)} />
          </label>
          {banner.kind !== "none" && (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => {
                setBanner({ kind: "none" });
                changed();
              }}
            >
              {t("channelBranding.removeBanner")}
            </button>
          )}
        </div>
      </section>

      {refusals.length > 0 && (
        <ul className="space-y-0.5 text-xs text-amber-300">
          {refusals.map((refusal) => (
            <li key={`${refusal.field}-${refusal.reason}`}>{refusalText(t, refusal)}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <ActionButton busy={saving} busyLabel={t("common.saving")} doneSignal={savedSignal} onClick={() => void save()} disabled={busy || !dirty || localRefusals.length > 0} className={primaryClass}>
          {t("channelBranding.save")}
        </ActionButton>
        <ActionButton busy={previewing} busyLabel={t("channelBranding.previewing")} onClick={() => void runPreview()} disabled={busy || dirty || !draft} className={buttonClass}>
          {t("channelBranding.preview")}
        </ActionButton>
        <button type="button" onClick={() => setConfirming(true)} disabled={!canApply} className={primaryClass}>
          {t("channelBranding.apply")}
        </button>
      </div>
      <p className="text-[11px] text-zinc-500">{dirty ? t("channelBranding.unsavedChanges") : t("channelBranding.previewHint")}</p>

      {preview && (
        <div className="space-y-2 rounded-lg border border-zinc-800 p-3 text-xs text-zinc-300">
          <ul className="space-y-0.5">
            {preview.fields.map((entry) => (
              <li key={entry.field}>
                {t(FIELD_KEYS[entry.field])} — {t(STATUS_KEYS[entry.status])}
              </li>
            ))}
          </ul>
          {preview.banner.next && preview.fields.some((f) => f.field === "banner" && f.status !== "unchanged") && <p>{t("channelBranding.bannerOrder")}</p>}
          {preview.quota.writes === 0 ? (
            <p>{t("channelBranding.nothingToWrite")}</p>
          ) : (
            <p>{t("channelBranding.quota", { units: String(preview.quota.writeUnits), writes: String(preview.quota.writes), reads: String(preview.quota.readUnits) })}</p>
          )}
        </div>
      )}
      {(loading || busy) && <LoadingIndicator className="text-xs text-zinc-400" />}
      <StatusNotice
        notice={error ? { tone: "error", text: error } : notice ? { tone: "ok", text: notice } : null}
        onClose={() => {
          setError(null);
          setNotice(null);
        }}
      />
      {confirming && preview && (
        <ConfirmDialog
          title={t("channelBranding.confirmTitle")}
          description={t("channelBranding.confirmBody", { fields: preview.fields.filter((f) => f.status !== "unchanged").map((f) => t(FIELD_KEYS[f.field])).join(", ") })}
          cancelLabel={t("common.cancel")}
          confirmLabel={t("channelBranding.confirm")}
          confirmBusyLabel={applying ? t("channelBranding.applying") : null}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void apply()}
        />
      )}
    </div>
  );
}
