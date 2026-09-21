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
export function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name -- required since the switch itself carries no visible text. */
  label: string;
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
        checked ? "border-red-900 bg-red-950/60" : "border-zinc-700 bg-zinc-800"
      } ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full transition-transform duration-200 ease-in-out ${
          checked ? "translate-x-[22px] bg-red-500" : "translate-x-1 bg-zinc-400"
        }`}
      />
    </button>
  );
}
