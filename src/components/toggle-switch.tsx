"use client";

/**
 * Shared horizontal toggle switch (owner instruction, 2026-09-21: "такие переключатели должны
 * быть горизонтальным тумблерами... красный кружок вправо -- включен, серый / черный выключен
 * влево... можно этот элемент сделать отдельным ассетом, чтобы его использовать везде где нужны
 * будут тумблеры"). Use this for any boolean ON/OFF setting -- never a native checkbox styled to
 * look like a switch, and never a multi-select list checkbox (a "select this row" checkbox in a
 * table/list is a different, real checkbox semantic and should stay `<input type="checkbox">`).
 *
 * A real `<button role="switch">`, not a styled `<input type="checkbox">`, so it is keyboard- and
 * screen-reader-accessible (Space/Enter toggle it, `aria-checked` reflects state) without extra
 * wiring at each call site.
 */
/**
 * BL-162 (owner, Telegram 2026-10-09, msg 2271): a calmer second look for switches that are not warnings -- "тумблеры не
 * обязательно должны быть всегда красными... возможно на этом экране подошёл бы фиолетовый". `accent` (red, the default) stays
 * for settings whose "on" matters; `violet` is the quieter one (the Media screens). Both live here, so the style stays one.
 */
const TONES = {
  accent: { track: "border-red-900 bg-red-950/60", thumb: "bg-red-500" },
  violet: { track: "border-violet-800 bg-violet-950/60", thumb: "bg-violet-400" },
} as const;

export type ToggleTone = keyof typeof TONES;

export function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  label,
  tone = "accent",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name -- required since the switch itself carries no visible text. */
  label: string;
  /** The "on" colour (default red). */
  tone?: ToggleTone;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors duration-200 ease-in-out ${
        checked ? TONES[tone].track : "border-zinc-700 bg-zinc-800"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full transition-transform duration-200 ease-in-out ${
          checked ? `translate-x-[22px] ${TONES[tone].thumb}` : "translate-x-1 bg-zinc-400"
        }`}
      />
    </button>
  );
}
