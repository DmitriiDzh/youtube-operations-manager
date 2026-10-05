/** Animated green check shown when an operation finishes successfully; `prefers-reduced-motion` users get it static. */
export function SuccessMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg role="img" aria-label="Success" viewBox="0 0 24 24" className={`ytom-success-pop shrink-0 ${className}`}>
      <circle cx="12" cy="12" r="11" className="fill-emerald-500/15 stroke-emerald-500" strokeWidth="1.5" />
      <path d="M7 12.5l3.2 3.2L17 8.8" className="ytom-success-tick" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
