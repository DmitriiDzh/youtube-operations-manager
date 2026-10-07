import { redirect } from "next/navigation";

// BL-149: Analytics opens on Overview.
export default function AnalyticsIndex() {
  redirect("/analytics/overview");
}
