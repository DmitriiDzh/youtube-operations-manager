import { notFound } from "next/navigation";
import { isSectionSubTab } from "@/components/section-tabs";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): the section's layout renders the sub-tab (its sub-tabs stay mounted and are
// only hidden, so switching never reloads them); this page gives the sub-tab its address and answers an unknown one with
// a real 404 (AC-RT-01).
export default async function SubTabPage({ params }: { params: Promise<{ sub: string }> }) {
  const { sub } = await params;
  if (!isSectionSubTab("settings", sub)) notFound();
  return null;
}
