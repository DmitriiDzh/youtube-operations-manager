"use client";

import { formatDisplayDateUtc } from "@/lib/shared-formatting";
import { isValidIanaTimezone, isValidLocalTimeOfDay, localTimeOfUtc } from "@/lib/zoned-time";
import { useT } from "./ui-text-provider";
import { useUserTimezone } from "./use-user-timezone";

/** The local time of a UTC time on a date, as the hint text: "(15:00 по вашему времени)", or the next/previous day's. */
export function useUtcLocalHint(utcTime: string, options: { on?: Date; timezone?: string | null } = {}): { text: string; title: string } | null {
  const t = useT();
  const userTimezone = useUserTimezone();
  const browserTimezone = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  const timezone = options.timezone && isValidIanaTimezone(options.timezone) ? options.timezone : (userTimezone ?? browserTimezone);
  if (!isValidLocalTimeOfDay(utcTime)) return null;
  const on = options.on ?? new Date();
  const { localTime, dayOffset } = localTimeOfUtc({ utcTime, on, timezone });
  const key = dayOffset > 0 ? "utcTime.localHintNextDay" : dayOffset < 0 ? "utcTime.localHintPreviousDay" : "utcTime.localHint";
  return { text: t(key, { time: localTime }), title: t("utcTime.localHintTitle", { zone: timezone, date: formatDisplayDateUtc(on) }) };
}

/**
 * Owner, Telegram msgs 2725/2727 (2026-10-13): a time of day is set in UTC, and the owner's own time is shown next to it in
 * parentheses for that date -- summer or winter. The one field every UTC time uses (the analytics collection times, the channel's
 * publish time), so the rule lives in one place. A controlled text input, never `type="time"` (its look depends on the browser
 * locale: "12.05" instead of "12:05", settings-input-widget-conventions). The local time is in the owner's zone (Settings →
 * "Your time zone"), or this browser's until it loads; `timezone` overrides it while that zone is being edited.
 */
export function UtcTimeField({
  label,
  value,
  onChange,
  invalid = false,
  on,
  timezone,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  /** The date the local time is shown for (default today): it decides summer or winter time. */
  on?: Date;
  timezone?: string | null;
  disabled?: boolean;
}) {
  const t = useT();
  const hint = useUtcLocalHint(value, { on, timezone });
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      <span className="flex items-center gap-2">
        <input
          type="text"
          inputMode="numeric"
          placeholder={t("format.timePlaceholder")}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={`w-20 rounded-lg border bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 disabled:opacity-60 ${invalid ? "border-red-700" : "border-zinc-700"}`}
        />
        <span className="text-sm text-zinc-300">{t("utcTime.utc")}</span>
        {hint && (
          <span className="text-xs text-zinc-500" title={hint.title}>
            {hint.text}
          </span>
        )}
      </span>
    </label>
  );
}
