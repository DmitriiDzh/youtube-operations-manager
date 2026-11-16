/**
 * BL-270 (owner TG 4662/4665): a poll that runs only while the tab is visible. A hidden tab (another tab in front, the window
 * minimised, a phone's locked screen) asks the server nothing; when it becomes visible again it asks at once and then resumes the
 * interval. The caller still makes its own first read on mount, as before. Returns the stop function for the effect's cleanup.
 */
export type VisibilityLike = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

export function startVisibleInterval(
  tick: () => void,
  intervalMs: number,
  doc: VisibilityLike | undefined = typeof document === "undefined" ? undefined : document
): () => void {
  let id: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    if (id === null) id = setInterval(tick, intervalMs);
  };
  const stop = () => {
    if (id !== null) clearInterval(id);
    id = null;
  };
  if (!doc) {
    start();
    return stop;
  }
  const onVisibility = () => {
    if (doc.hidden) {
      stop();
      return;
    }
    if (id === null) {
      tick();
      start();
    }
  };
  if (!doc.hidden) start();
  doc.addEventListener("visibilitychange", onVisibility);
  return () => {
    stop();
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
