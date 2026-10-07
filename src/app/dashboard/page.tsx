import { redirect } from "next/navigation";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md, AC-RT-04): the app's single address until 2026-10-07. Every section now has
// its own address; an old link or bookmark lands on Home, and a Google Cloud OAuth result (`?cloudConnection=`) on the
// Settings sub-tab that shows it.
export default async function DashboardRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  const target = query.has("cloudConnection") ? "/settings/api" : "/home";
  redirect(query.size > 0 ? `${target}?${query.toString()}` : target);
}
