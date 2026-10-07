# Real addresses for every section (BL-149)

**Decided** by the owner in Telegram on 2026-10-07:
- msg 1996: the problem;
- msg 1999: option B, with addresses without a prefix.

## Problem

Today the whole UI is one client page, `src/app/dashboard/page.tsx`. The active section lives in component state (`useState("home")`), and so do the sub-tabs of each section and the plan review screen.

This has five consequences:
1. A reload or a server restart always lands on Home.
2. The browser's Back button leaves the app.
3. A section cannot be opened in a second browser tab, bookmarked, or linked.
4. After the Google Cloud OAuth callback, the app returns to `/dashboard`, which shows Home. The result banner sits in Settings → API, where nobody sees it.
5. The first load downloads every section's code.

No requirement depends on the single address. It is inherited from the original template.

## Addresses

| Address | Shows |
|---|---|
| `/home`, `/content`, `/languages`, `/batches`, `/decisions`, `/merge` | the section |
| `/production` | redirects to `/production/sessions` |
| `/production/<sub>` | `sub` is one of: sessions, jobs, plans, models, templates, setup |
| `/production/plans/<planId>/review` | the plan review screen. `?device=<deviceId>` selects another device's plan. |
| `/analytics/<sub>` | `sub` is one of: overview, content, audience |
| `/research` | Inbox when agent requests are waiting, else Channels (the existing first-open rule, AC-R1-2) |
| `/research/<sub>` | `sub` is one of: inbox, channels, videos, discover, topics |
| `/settings` | redirects to `/settings/general` |
| `/settings/<sub>` | `sub` is one of: general, api, channels, ai-agent, sync, runpod, about |
| `/dashboard` (old link) | redirects to `/home`, keeping the query. A `cloudConnection` result goes to `/settings/api`. |
| `/` | the sign-in page, as now. Signed in → `/home`. |

Languages' status filter (In progress / Approved / …) is a list filter, not a section. It stays as it is.

## Design

- **Route group `src/app/(app)/`.**
  - Its client `layout.tsx` takes over from `dashboard/page.tsx` everything that is not a section:
    - the session check;
    - `AppShell`, with nav items as links and the active item taken from the path;
    - the active channel, exposed as a React context;
    - the connection-health dialog;
    - `OperationLockControl`;
    - every background poll and the once-per-load triggers (conflict summary, sync cycle, Research pending, plans waiting, auto-collect, reach sync).
  - A layout persists across navigations, so these run once per app load, exactly as now. Navigating between sections no longer restarts them.
- **Sub-tabs keep their accepted behaviour.**
  - "Every sub-tab stays mounted and is only hidden" (Research AC-R1-1, Settings, owner: no flicker). Each such section renders its component from its own `layout.tsx`, which persists while only the sub-path changes, and takes the sub-tab from the path.
  - The `page.tsx` files under it render nothing.
  - Clicking a sub-tab navigates (`router.push`) instead of setting state.
- **Channel switch.** Content, Production, Analytics, Languages and Home still remount on a channel change (`key={channel.id}`), so each re-reads the active channel.
- **Settings preload.** Settings is currently mounted, hidden, from the first load, so its cards are ready when opened (owner request). Being on its own page, Settings now mounts on first open. The trade-off is decided by the owner, msg TBD:
  - (a) keep it as today: mount it hidden in the shared layout, which also keeps the Cloud Monitoring call on every load;
  - (b) mount on first visit: a short loading moment on the first open of Settings only.
- **Components change minimally.**
  - `ProductionPanel`, `ResearchTab`, `AnalyticsTab` and `PlansPanel` get the active sub-tab (and the plan under review) as props, plus a callback to navigate, instead of owning them as state.
  - Their content is unchanged.
- **No server or API change.**
  - `proxy.ts` only handles `/api/*`.
  - The presence beacon (idle shutdown) is in the root layout, so it runs on every page.

## Acceptance criteria (written before the code)

- AC-RT-01: every address in the table renders its section and sub-tab with the matching sidebar item active. An unknown sub-path shows Next's not-found page.
- AC-RT-02: reloading any of these addresses shows the same section and sub-tab, not Home.
- AC-RT-03: sidebar and sub-tab clicks change the address. Back and Forward move between them.
- AC-RT-04: `/dashboard` → `/home`. `/dashboard?cloudConnection=…` → `/settings/api?cloudConnection=…`, and the OAuth callback redirects there directly. Signed-in `/` → `/home`.
- AC-RT-05: the background polls and the once-per-load triggers run once per app load. Moving between sections does not restart them, and the badges stay current on every page.
- AC-RT-06: Research and Settings sub-tabs stay mounted and are only hidden. Switching sub-tabs never refetches. Research's first-open rule still applies to `/research`.
- AC-RT-07: `/production/plans/<id>/review` opens the review screen for that plan, and Close returns to `/production/plans`. A peer plan uses `?device=`.
- AC-RT-08: a channel switch still makes the channel-bound sections re-read the active channel.
- AC-RT-09: signed out, any of these addresses goes to the sign-in page.

## Slices (one branch `feature/app-routes`, one merge)

1. The `(app)` layout with the shell, context and polls; one route per top-level section; the `/dashboard` redirect; the OAuth callback (AC-01..05, 08, 09).
2. Sub-tabs in the path: Production, Research, Analytics, Settings (AC-01..03, 06).
3. Plan review address (AC-07); docs.

Each slice is checked in the browser on a dev build before moving on.
