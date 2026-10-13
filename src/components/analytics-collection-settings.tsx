"use client";

import { errorText } from "@/lib/ui-text";
import { ownSettingsUnavailable } from "./settings-unavailable";
import { useCallback, useEffect, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import { resetUserTimezoneCache } from "./use-user-timezone";
import { DEFAULT_ANALYTICS_EVENING_UTC_TIME, isValidIanaTimezone, isValidLocalTimeOfDay } from "@/lib/analytics/staleness";
import { LoadingIndicator } from "./operation-progress";
import { ToggleSwitch } from "./toggle-switch";
import { useT } from "./ui-text-provider";
import { UtcTimeField } from "./utc-time-field";

// `Intl.supportedValuesOf` (ES2022) -- the real, canonical IANA timezone database this runtime
// ships, not a hand-maintained list that could drift from it. Backing a <datalist> rather than a
// plain <select> per the owner's own request (2026-09-25): "лучше сделать выбор из списка, в
// который можно вводить, чтобы сузить список" -- typing still narrows the list, but an exact,
// valid IANA name can also still be typed directly (the server-side `isValidIanaTimezone` check
// below is the actual source of truth either way, this list is discoverability only).
const IANA_TIMEZONES: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

type SyncSettings = {
  /** "HH:MM" in UTC (owner, Telegram msgs 2725/2727, 2026-10-13). */
  analyticsSyncUtcTime: string;
  /** BL-181: the evening re-collect boundary in UTC, "" when off. */
  analyticsEveningUtcTime: string;
  /** The owner's own zone: the local times in parentheses, the quota reset time. */
  userTimezone: string;
};

/**
 * Settings-tab section for BL-059's daily auto-collection boundary (docs/roadmap/plans/PHASE_8_PLAN.md §10 items 3-4) and
 * BL-181's evening re-collect (a ToggleSwitch with its time). Since 2026-10-13 both times are set in UTC, with the owner's own
 * time in parentheses (`UtcTimeField`, owner msgs 2725/2727); the zone field is the owner's own zone, which those parentheses
 * and the quota reset time use. It defaults to this machine's OS zone the first time it is read, then persists. Every value is
 * validated server-side before being saved (`isValidLocalTimeOfDay`/`isValidIanaTimezone`, `/api/settings`).
 */
export function AnalyticsCollectionSettings() {
  const t = useT();
  const [settings, setSettings] = useState<SyncSettings | null>(null);
  const [draft, setDraft] = useState<SyncSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    const res = await fetch("/api/settings");
    if (!res.ok) return;
    const data = (await res.json()) as SyncSettings;
    if (ownSettingsUnavailable(data, ["analyticsTimes", "userTimezone"])) return;
    setSettings(data);
    setDraft(data);
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Only this card's own fields -- never the whole snapshot (see read-gateway-settings.tsx).
        body: JSON.stringify({
          analyticsSyncUtcTime: draft.analyticsSyncUtcTime,
          analyticsEveningUtcTime: draft.analyticsEveningUtcTime,
          userTimezone: draft.userTimezone,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("settings.saveFailed"), { showErrorField: false }));
        return;
      }
      setSettings(data);
      setDraft(data);
      resetUserTimezoneCache();
      setSavedNotice(t("common.saved"));
    } catch {
      setError(t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (!settings || !draft) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
        <LoadingIndicator className="text-sm text-zinc-400" />
      </div>
    );
  }

  const dirty =
    draft.analyticsSyncUtcTime !== settings.analyticsSyncUtcTime ||
    draft.userTimezone !== settings.userTimezone ||
    draft.analyticsEveningUtcTime !== settings.analyticsEveningUtcTime;

  const timeValid = isValidLocalTimeOfDay(draft.analyticsSyncUtcTime);
  const timezoneValid = isValidIanaTimezone(draft.userTimezone);
  const eveningOn = draft.analyticsEveningUtcTime !== "";
  const eveningFormatValid = !eveningOn || isValidLocalTimeOfDay(draft.analyticsEveningUtcTime);
  // Same rule the server enforces: the evening boundary is later in the (UTC) day than the collection time.
  const eveningOrderValid = !eveningOn || !eveningFormatValid || !timeValid || draft.analyticsEveningUtcTime > draft.analyticsSyncUtcTime;
  const eveningValid = eveningFormatValid && eveningOrderValid;

  return (
    <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-medium text-zinc-100">
          {t("analyticsCollection.title")}
          <InfoTooltip>{t("analyticsCollection.info")}</InfoTooltip>
        </h3>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <UtcTimeField
          label={t("analyticsCollection.time")}
          value={draft.analyticsSyncUtcTime}
          onChange={(value) => setDraft({ ...draft, analyticsSyncUtcTime: value })}
          invalid={!timeValid}
          timezone={timezoneValid ? draft.userTimezone : null}
        />
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          <span className="flex items-center gap-1.5">
            {t("analyticsCollection.timezone")}
            <InfoTooltip>{t("analyticsCollection.timezoneInfo")}</InfoTooltip>
          </span>
          <input
            type="text"
            list="analytics-sync-iana-timezones"
            value={draft.userTimezone}
            onChange={(e) => setDraft({ ...draft, userTimezone: e.target.value })}
            placeholder={t("analyticsCollection.timezonePlaceholder")}
            className={`min-w-56 rounded-lg border bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 ${
              timezoneValid ? "border-zinc-700" : "border-red-700"
            }`}
          />
          {/* Typing still narrows this list (native <datalist> behavior) while an exact IANA name
              can also be typed directly -- narrows the free-text error surface the owner flagged
              (2026-09-25: "свободный ввод... это место для потенциальной ошибки") without losing
              the ability to enter any zone this runtime actually supports. */}
          <datalist id="analytics-sync-iana-timezones">
            {IANA_TIMEZONES.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </label>
        <div className="flex items-center gap-2 pb-1.5">
          <ToggleSwitch
            label={t("analyticsCollection.evening")}
            checked={eveningOn}
            onChange={(checked) => setDraft({ ...draft, analyticsEveningUtcTime: checked ? settings.analyticsEveningUtcTime || DEFAULT_ANALYTICS_EVENING_UTC_TIME : "" })}
          />
          <span className="flex items-center gap-1.5 text-sm text-zinc-300">
            {t("analyticsCollection.evening")}
            <InfoTooltip>{t("analyticsCollection.eveningInfo")}</InfoTooltip>
          </span>
        </div>
        {eveningOn && (
          <UtcTimeField
            label={t("analyticsCollection.eveningTime")}
            value={draft.analyticsEveningUtcTime}
            onChange={(value) => setDraft({ ...draft, analyticsEveningUtcTime: value })}
            invalid={!eveningValid}
            timezone={timezoneValid ? draft.userTimezone : null}
          />
        )}
        <button
          onClick={handleSave}
          disabled={saving || !dirty || !timeValid || !timezoneValid || !eveningValid}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
      </div>

      {(!timeValid || !timezoneValid || !eveningValid) && (
        <p className="text-xs text-red-400">
          {(!timeValid || !eveningFormatValid) && `${t("analyticsCollection.invalidTime")} `}
          {!timezoneValid && `${t("analyticsCollection.invalidTimezone")} `}
          {!eveningOrderValid && t("analyticsCollection.eveningMustBeLater")}
        </p>
      )}
      {savedNotice && <p className="text-sm font-medium text-green-500">{savedNotice}</p>}
      {error && (
        <div className="rounded-lg border border-red-900 bg-red-950/50 p-3 text-sm text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}
