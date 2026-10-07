// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): the sub-tabs of each section that has them, and the address rules, in a
// plain module (no "use client"), so the server pages validate a sub-tab address (a real 404) and the client components
// render the same lists -- one owner for each list. Tab names are BL-152 interface-text keys.

export const PRODUCTION_TABS = [
  { value: "sessions", labelKey: "tabs.production.sessions", side: "work" },
  { value: "jobs", labelKey: "tabs.production.jobs", side: "work" },
  // BL-143 (ADR 0029, AC-GP-15): generation plans, next to the jobs they are made of.
  { value: "plans", labelKey: "tabs.production.plans", side: "work" },
  { value: "models", labelKey: "tabs.production.models", side: "work" },
  { value: "templates", labelKey: "tabs.production.templates", side: "work" },
  { value: "setup", labelKey: "tabs.production.setup", side: "setup" },
] as const;

export const RESEARCH_TABS = [
  { value: "inbox", labelKey: "tabs.research.inbox" },
  { value: "channels", labelKey: "tabs.research.channels" },
  { value: "videos", labelKey: "tabs.research.videos" },
  { value: "discover", labelKey: "tabs.research.discover" },
  { value: "topics", labelKey: "tabs.research.topics" },
] as const;

export const ANALYTICS_SUB_TABS = [
  { key: "overview", labelKey: "tabs.analytics.overview" },
  { key: "content", labelKey: "tabs.analytics.content" },
  { key: "audience", labelKey: "tabs.analytics.audience" },
] as const;

// Settings sub-tabs (owner instruction, 2026-09-23: "давай в настройках сделаем 4 категории
// закладок"). "AI Agent" deliberately groups two technically unrelated mechanisms -- the MCP
// connection toggle (how an external AI agent like Codex/Claude connects TO this app) and AI
// provider connections (how this app connects OUT to an AI provider for AI Localization) -- per
// the owner's own explicit choice after this distinction was raised and confirmed understood.
export const SETTINGS_SUB_TABS = [
  { value: "general", labelKey: "tabs.settings.general" },
  { value: "api", labelKey: "tabs.settings.api" },
  { value: "channels", labelKey: "tabs.settings.channels" },
  { value: "ai-agent", labelKey: "tabs.settings.aiAgent" },
  { value: "sync", labelKey: "tabs.settings.sync" },
  // Phase 14 (docs/roadmap/plans/PHASE_14_PLAN.md §2.6, D5): the RunPod connection only since slice 6 (owner, msg 1549);
  // everything else is the Production section.
  { value: "runpod", labelKey: "tabs.settings.runpod" },
  { value: "about", labelKey: "tabs.settings.about" },
] as const;

export type ProductionTab = (typeof PRODUCTION_TABS)[number]["value"];
export type ResearchSubTab = (typeof RESEARCH_TABS)[number]["value"];
export type AnalyticsSubTab = (typeof ANALYTICS_SUB_TABS)[number]["key"];
export type SettingsSubTab = (typeof SETTINGS_SUB_TABS)[number]["value"];

const SUB_TABS_BY_SECTION: Record<string, readonly string[]> = {
  production: PRODUCTION_TABS.map((t) => t.value),
  research: RESEARCH_TABS.map((t) => t.value),
  analytics: ANALYTICS_SUB_TABS.map((t) => t.key),
  settings: SETTINGS_SUB_TABS.map((t) => t.value),
};

/** AC-RT-01: is `/<section>/<sub>` a sub-tab address? */
export function isSectionSubTab(section: string, sub: string): boolean {
  return SUB_TABS_BY_SECTION[section]?.includes(sub) ?? false;
}

/**
 * AC-RT-04: where the old single address `/dashboard?…` goes -- Home, or the Settings sub-tab that shows a Google Cloud OAuth
 * result (`cloudConnection`) -- keeping every query parameter, repeated ones included.
 */
export function dashboardRedirectTarget(params: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  const target = query.has("cloudConnection") ? "/settings/api" : "/home";
  return query.size > 0 ? `${target}?${query.toString()}` : target;
}

/**
 * Review finding (BL-149): a sidebar item leads back to the sub-tab last open in its section (clicking the section you are
 * in keeps you where you are; Settings reopens on the sub-tab you left), else to the section's own address.
 */
export function sectionHref(sectionHref: string, lastPathBySection: Readonly<Record<string, string>>): string {
  return lastPathBySection[sectionHref] ?? sectionHref;
}

/**
 * What a sidebar item may lead back to for a visited path (re-review): only a real sub-tab address (`/settings/sync`), never
 * a mistyped one (that would lead back to a 404); a plan's review counts as Plans (its peer query is not part of the path,
 * and the sidebar must still lead out of it). Null = nothing to remember.
 */
export function rememberablePath(pathname: string): { section: string; path: string } | null {
  const [, section, sub, planId, last, ...rest] = pathname.split("/");
  if (!section || !sub) return null;
  if (section === "production" && sub === "plans" && planId && last === "review" && rest.length === 0) return { section: "/production", path: "/production/plans" };
  if (planId !== undefined || !isSectionSubTab(section, sub)) return null;
  return { section: `/${section}`, path: pathname };
}

/** The section (`/production`) a path belongs to, among the given section addresses; null when none. */
export function sectionOf(pathname: string, sectionHrefs: readonly string[]): string | null {
  return sectionHrefs.find((href) => pathname === href || pathname.startsWith(`${href}/`)) ?? null;
}
