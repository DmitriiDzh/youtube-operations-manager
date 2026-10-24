"use client";

// YouTube Studio-style app shell: a persistent left sidebar (icon + label nav, red active
// indicator) and a top bar (active channel + channel switch + sign out), replacing the
// previous single horizontal pill-tab-bar-as-navigation. Purely a chrome/layout change --
// every existing tab's own content component is rendered completely unchanged inside it.
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ComponentType, type MouseEvent, type ReactNode, type SVGProps } from "react";
import type { ChannelInfo } from "@/components/app-channel";
import type { PlanChannelWork } from "@/lib/generation-plans/contracts";
import { ChannelSwitcher } from "./channel-switcher";
import { ActivityIndicator } from "./activity-indicator";
import { DeviceSyncBell } from "./device-sync-bell";
import type { ChannelWorkEntry } from "./channel-work";
import { FeatureErrorBoundary } from "./feature-error-boundary";
import { useT } from "./ui-text-provider";

export type NavItem<T extends string> = {
  value: T;
  /** BL-149: each section has its own address; the item is a real link (middle-click opens it in a new browser tab). */
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** A small count badge next to the label (e.g. unresolved CRDT conflicts awaiting a decision,
   * AUTOMERGE_MIGRATION_PLAN.md §6 CD6, AC-CRDT-08) -- omitted or 0 renders no badge at all. */
  badge?: number;
  /** Shown when hovering the badge (e.g. what the count is made of). */
  badgeTitle?: string;
};

export function AppShell<T extends string>(props: {
  navItems: readonly NavItem<T>[];
  activeTab: T | null;
  channel: Pick<ChannelInfo, "title" | "thumbnail" | "videoCount"> | null;
  /** The channel request failed (typically a stale Google sign-in): say so instead of "Loading..." forever. */
  channelUnavailable?: boolean;
  onSignOut: () => void;
  /** Where the bell's "see what differs" leads (the Merge tab). */
  onReviewDeviceSyncDivergence?: () => void;
  /** BL-157 (SERVERS_MEDIA_PLAN.md §D): every connected channel's open Media work -- the switcher's counts, the bell's entries. */
  activeChannelId?: string | null;
  channelWork?: readonly PlanChannelWork[];
  /** BL-178 part C: the other channels' translation alerts, shown in the bell. */
  languageEntries?: readonly ChannelWorkEntry[];
  /** BL-182: the other channels' publishing-coverage reminders. */
  publishingEntries?: readonly ChannelWorkEntry[];
  /** BL-184: the other channels' storyboards waiting for review. */
  storyboardEntries?: readonly ChannelWorkEntry[];
  /** A bell entry's button: switch to that channel, then open `href`. */
  onOpenChannelWork?: (channelId: string, href: string) => void;
  children: ReactNode;
}) {
  const t = useT();
  // BL-203 (FAST_NAVIGATION_PLAN.md §2 stage 2): the clicked item shows as selected at once, not only once the new page is committed,
  // so a click is visibly taken even while the server is still answering. Cleared when the address changes (or never arrives).
  const pathname = usePathname();
  const [pending, setPending] = useState<{ value: T; from: string } | null>(null);
  // Once the address moves on (the page arrived, or Back / an in-page link went elsewhere), the click is settled: forget it, so a
  // later return to the address it was made from never shows it again (React's adjust-state-during-render pattern).
  if (pending && pending.from !== pathname) setPending(null);
  const pendingValue = pending && pending.from === pathname ? pending.value : null;
  useEffect(() => {
    if (!pendingValue) return;
    const id = setTimeout(() => setPending(null), 15_000);
    return () => clearTimeout(id);
  }, [pendingValue]);
  const selected = pendingValue ?? props.activeTab;
  function onNavClick(event: MouseEvent<HTMLAnchorElement>, value: T) {
    // A middle/modified click opens another browser tab; this one does not navigate.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (value !== props.activeTab) setPending({ value, from: pathname });
  }
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="flex h-16 items-center gap-2 px-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-sm font-bold text-white">
            {/* ui-text-ignore: the logo mark */}
            YT
          </div>
          <span className="text-sm font-semibold tracking-tight">{t("shell.productName")}</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2 py-2">
          {props.navItems.map((item) => {
            const active = item.value === selected;
            const Icon = item.icon;
            return (
              <Link
                key={item.value}
                href={item.href}
                aria-current={item.value === props.activeTab ? "page" : undefined}
                onClick={(event) => onNavClick(event, item.value)}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-surface font-medium text-white"
                    : "text-muted hover:bg-surface-hover hover:text-white"
                }`}
              >
                <Icon className={active ? "h-5 w-5 text-accent" : "h-5 w-5"} />
                {item.label}
                <NavPendingMark forced={item.value === pendingValue} />
                {!!item.badge && (
                  <span title={item.badgeTitle} className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white">
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-border px-6">
          <div className="flex items-center gap-3">
            {props.channel?.thumbnail && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={props.channel.thumbnail}
                alt={props.channel.title}
                className="h-9 w-9 rounded-full"
              />
            )}
            <div>
              <p className="text-xs text-muted">{t("shell.activeChannel")}</p>
              <p className="text-sm font-medium">
                {props.channel?.title ?? (props.channelUnavailable ? t("shell.reconnectNeeded") : t("common.loading"))}
                {props.channel?.videoCount && (
                  <span className="ml-2 text-xs text-muted" title={t("shell.videoCountHint")}>{t("shell.videoCount", { count: Number(props.channel.videoCount) })}</span>
                )}
              </p>
            </div>
            <ChannelSwitcher channelWork={props.channelWork} />
          </div>
          <div className="flex items-center gap-3">
            {/* BL-195 stage D: what runs in the background now (UI_FEEDBACK_CLARITY_PLAN.md §3). */}
            <FeatureErrorBoundary label={t("shell.activity")}>
              <ActivityIndicator />
            </FeatureErrorBoundary>
            <FeatureErrorBoundary label={t("shell.deviceSync")}>
              <DeviceSyncBell
                onReviewDivergence={props.onReviewDeviceSyncDivergence}
                activeChannelId={props.activeChannelId ?? null}
                channelWork={props.channelWork}
                languageEntries={props.languageEntries}
                publishingEntries={props.publishingEntries}
                storyboardEntries={props.storyboardEntries}
                onOpenChannelWork={props.onOpenChannelWork}
              />
            </FeatureErrorBoundary>
            <button
              onClick={props.onSignOut}
              className="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent hover:text-white"
            >
              {t("shell.signOut")}
            </button>
          </div>
        </header>

        {/* No max-width cap here (removed 2026-09-20, matching real Studio's own content
            region, which fills available width rather than centering a fixed narrow column) --
            a table-heavy tab (Content/Languages/Batches) needs the full width to be usable on a
            wide viewport. A tab whose content is narrow by nature (forms/cards: Home, Settings,
            Device) applies its own max-width locally instead, so this shell stays width-agnostic
            for every tab rather than picking one width that's wrong for half of them. */}
        {/* BL-203: a thin bar under the header while a menu click waits for its page. Always 2 px tall, so nothing shifts. */}
        <div className="relative h-0.5 shrink-0 overflow-hidden">
          {pendingValue && <div role="progressbar" aria-label={t("shell.navigating")} className="ytom-nav-progress absolute inset-y-0 w-1/3 bg-accent" />}
        </div>
        <main className="flex-1 overflow-y-auto px-6 py-6">{props.children}</main>
      </div>
    </div>
  );
}

/** BL-203: a fixed-size spinner inside a menu link, visible while that link's navigation is pending. `useLinkStatus` covers a click
 * Next has not committed yet; `forced` covers the item the shell itself marked as clicked. */
function NavPendingMark({ forced }: { forced: boolean }) {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={`inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-zinc-600 border-t-accent transition-opacity motion-reduce:animate-none ${
        pending || forced ? "opacity-100" : "opacity-0"
      }`}
    />
  );
}
