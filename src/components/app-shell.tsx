"use client";

// YouTube Studio-style app shell: a persistent left sidebar (icon + label nav, red active
// indicator) and a top bar (active channel + channel switch + sign out), replacing the
// previous single horizontal pill-tab-bar-as-navigation. Purely a chrome/layout change --
// every existing tab's own content component is rendered completely unchanged inside it.
import type { ComponentType, ReactNode, SVGProps } from "react";
import type { ChannelInfo } from "@/app/dashboard/page";

export type NavItem<T extends string> = {
  value: T;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** A small count badge next to the label (e.g. unresolved CRDT conflicts awaiting a decision,
   * AUTOMERGE_MIGRATION_PLAN.md §6 CD6, AC-CRDT-08) -- omitted or 0 renders no badge at all. */
  badge?: number;
};

export function AppShell<T extends string>(props: {
  navItems: readonly NavItem<T>[];
  activeTab: T;
  onTabChange: (tab: T) => void;
  channel: Pick<ChannelInfo, "title" | "thumbnail" | "videoCount"> | null;
  userName?: string | null;
  onSwitchChannel: () => void;
  onSignOut: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="flex h-16 items-center gap-2 px-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-accent text-sm font-bold text-white">
            YT
          </div>
          <span className="text-sm font-semibold tracking-tight">Operations Manager</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-2 py-2">
          {props.navItems.map((item) => {
            const active = item.value === props.activeTab;
            const Icon = item.icon;
            return (
              <button
                key={item.value}
                onClick={() => props.onTabChange(item.value)}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-surface font-medium text-white"
                    : "text-muted hover:bg-surface-hover hover:text-white"
                }`}
              >
                <Icon className={active ? "h-5 w-5 text-accent" : "h-5 w-5"} />
                {item.label}
                {!!item.badge && (
                  <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white">
                    {item.badge}
                  </span>
                )}
              </button>
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
              <p className="text-xs text-muted">Active channel</p>
              <p className="text-sm font-medium">
                {props.channel?.title ?? "Loading..."}
                {props.channel?.videoCount && (
                  <span className="ml-2 text-xs text-muted">{props.channel.videoCount} videos</span>
                )}
              </p>
            </div>
            <button
              onClick={props.onSwitchChannel}
              className="ml-2 rounded-full border border-border px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-accent hover:text-white"
            >
              Switch channel
            </button>
          </div>
          <div className="flex items-center gap-3">
            {props.userName && <span className="text-sm text-muted">{props.userName}</span>}
            <button
              onClick={props.onSignOut}
              className="rounded-full border border-border px-4 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent hover:text-white"
            >
              Sign out
            </button>
          </div>
        </header>

        {/* No max-width cap here (removed 2026-09-20, matching real Studio's own content
            region, which fills available width rather than centering a fixed narrow column) --
            a table-heavy tab (Content/Languages/Batches) needs the full width to be usable on a
            wide viewport. A tab whose content is narrow by nature (forms/cards: Home, Settings,
            Device) applies its own max-width locally instead, so this shell stays width-agnostic
            for every tab rather than picking one width that's wrong for half of them. */}
        <main className="flex-1 overflow-y-auto px-6 py-6">{props.children}</main>
      </div>
    </div>
  );
}
