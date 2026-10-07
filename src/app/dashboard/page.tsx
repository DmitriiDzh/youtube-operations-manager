import { redirect } from "next/navigation";
import { dashboardRedirectTarget } from "@/components/section-tabs";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md, AC-RT-04): the app's single address until 2026-10-07. Every section now has
// its own address; an old link or bookmark lands on Home, and a Google Cloud OAuth result (`?cloudConnection=`) on the
// Settings sub-tab that shows it.
export default async function DashboardRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(dashboardRedirectTarget(await searchParams));
}
