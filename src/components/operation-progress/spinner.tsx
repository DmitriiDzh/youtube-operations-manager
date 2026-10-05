/** Small inline spinner; `motion-reduce` users get a static ring instead of the rotation. */
export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-2 border-zinc-600 border-t-red-500 motion-reduce:animate-none ${className}`}
    />
  );
}
