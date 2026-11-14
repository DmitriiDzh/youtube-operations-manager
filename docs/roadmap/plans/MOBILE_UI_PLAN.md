# BL-254 — YT Manager on a phone (research and plan)

Owner, Telegram 2026-11-14 msg 4257: after BL-251 (phone access over Tailscale) the UI is desktop-only; research and plan
how it should look on a phone, as a professional UI/UX designer, **without changing the desktop version**.

## Audit (live screens, 14.11, Chrome at the narrowest window, ~600 px; a phone is 360–430 px)
- **Shell:** the sidebar is a fixed `w-60` (240 px): ~40 % of a 600 px window, ~60 % of a phone. Nothing collapses.
- **Header:** channel name, video count, «Сменить канал», the bell and «Выйти» squeeze into one row; the channel name
  wraps into a column of single words.
- **Content area:** `px-6 py-6` everywhere; section tabs (Видео / Ролики и релизы / План недели / Календарь …) wrap to
  two or three lines; long titles truncate at `max-w-[24rem]`; one `overflow-x-auto` block is 668 px in a 281 px box.
- **Code:** 244 components, ~80 responsive classes in total (53 `sm:`, 13 `md:`, 9 `lg:`); 20 components render `<table>`;
  12 full-screen overlays (`fixed inset-0`) built for a large screen. The viewport is not a phone layout anywhere.

## What the owner does on a phone (jobs, in order of value)
1. **Approve or veto** — the week plan's slots (Content → План недели), clips (Media → Клипы), storyboards, the System
   topic's paid-call approvals: read, look/listen, press one button, maybe add a comment.
2. **Check status** — the bell (publishing, conflicts, sync), today's uploads, live streams, the restart card.
3. **Glance at numbers** — the latest video, views, Overview analytics.
4. Everything else (Servers, Research, Decisions, Batches, Merge, most of Settings) is desk work: readable on a phone,
   not optimised.

## Principles
- **Desktop untouched:** every change lives under a phone breakpoint — Tailwind `max-md:` (below 768 px) or a
  phone-only element hidden with `md:hidden` — never a change to a class that applies at ≥ 768 px. No user-agent sniffing.
  Acceptance includes pixel-identical desktop screenshots before / after.
- **One app, reflowed:** the same routes, data and components; a phone gets a different shell and card layouts, not a
  second product.
- **Thumb first:** primary actions within reach at the bottom, touch targets ≥ 44 px, no hover-only controls, inputs
  ≥ 16 px (iOS does not zoom them).
- **Mac-only stays Mac-only:** BL-251's remote gate is unchanged; on the phone those controls are simply not offered.

## Design
- **Shell (< 768 px):** no sidebar. A **bottom tab bar** with five entries — Главная, Контент, Медиа, Аналитика,
  **Ещё** (a sheet with the other sections and Settings), badges kept. A **compact top bar**: channel avatar (tap = the
  channel switcher as a bottom sheet), the section title, the bell (opens a full-screen sheet). «Выйти» moves into Ещё.
  Content padding `px-4 py-4`; safe-area insets (`env(safe-area-inset-*)`) for the notch and the home indicator.
- **Section tabs:** one horizontally scrollable row (snap, the active tab scrolled into view), never wrapping.
- **Lists and tables → cards:** a shared `ResponsiveTable` pattern — rows become cards with the title, a status chip and
  the one key number; secondary columns fold into the card's details. Applies to the 20 tables, starting with videos,
  uploads, plan slots, clips.
- **Popups → sheets:** the video details popup, confirmation rows and dialogs open as full-height bottom sheets with a
  sticky action bar (Одобрить / Вернуть) above the home indicator.
- **Calendar → agenda:** the month grid stays on desktop; the phone gets a day-by-day list with the coverage chips.
- **Players:** clips and audio full-width, `playsinline`, the decision bar sticky under the player.
- **Add to Home Screen:** a web app manifest + icons + theme colour, so YTM opens full-screen from the phone's home screen
  (standalone display, no browser bars). Works over the Tailscale HTTPS address.

## Stages (each a working, merged unit; the owner checks on the phone after each)
1. **Shell** (~1 day): bottom tab bar + Ещё sheet, compact top bar, channel switcher and bell as sheets, padding, safe
   areas, scrollable section tabs, manifest + icons. After this every screen is usable, if not pretty.
2. **Approvals** (~2 days): week-plan slots as cards with sticky approve / veto; clips review (player + decision bar,
   comment, attachments from the phone's camera roll); storyboard replies; the bell's entries tappable to their target.
3. **Status and numbers** (~1.5 days): Home cards stacked, uploads and live streams as cards, calendar agenda, analytics
   Overview cards (charts scroll sideways inside their card), the restart card.
4. **The rest** (~1 day): the `ResponsiveTable` pattern on the remaining tables; desk-only sections get a quiet «удобнее
   на компьютере» note and a basic reflow.

## Acceptance criteria
- AC-M-1 At 390 × 844 no route scrolls the page sideways (an automated check over every route: `scrollWidth <= innerWidth`).
- AC-M-2 At 1440 × 900 and 1280 × 800 every route renders pixel-identical before / after each stage (screenshot diff).
  Stage 1 was checked by computed layout (sidebar 240 px, header 64 px, padding 24 px, bottom bar `display:none` at 1440 px)
  on a sandboxed copy of the data, not by a pixel diff; the theme colour was then limited to phones (review: desktop Safari
  tinted its tab bar). Later stages add a pixel diff of the same pages before / after.
- AC-M-3 Every primary action of jobs 1–2 is reachable with one thumb: ≥ 44 px targets, inside the bottom 40 % of the
  screen or in a sticky bar.
- AC-M-4 Inputs are ≥ 16 px on a phone (no iOS zoom); nothing depends on hover.
- AC-M-5 Mac-only controls (BL-251 list) are not shown on a phone; nothing in the remote gate changes.
- AC-M-6 New texts have keys in every locale (AGENTS.md §H).
- AC-M-7 Added to the home screen, YTM opens standalone with its icon and the dark theme colour.

## Not in scope
A separate mobile app; offline mode; push notifications (possible later through the Telegram bot the owner already uses);
redesigning desktop screens.
