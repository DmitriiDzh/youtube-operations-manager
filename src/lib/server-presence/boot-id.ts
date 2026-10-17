import { randomUUID } from "node:crypto";

/**
 * BL-196 (docs/roadmap/plans/FAST_STARTUP_PLAN.md §2 A): one id per run of this server process, so a page can tell a reload (same id:
 * the startup window was already shown in this tab) from the first load after a restart (new id: show it again). Held on `globalThis`
 * so every module copy Next loads shares it (like the operation registry). Not a secret: it only names the run.
 */
export function serverBootId(): string {
  const holder = globalThis as unknown as Record<symbol, string | undefined>;
  return (holder[Symbol.for("youtube-operations-manager.server-boot-id")] ??= randomUUID());
}
