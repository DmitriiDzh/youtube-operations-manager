import { redirect } from "next/navigation";

// BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-01): Media opens on Plans.
export default function MediaIndex() {
  redirect("/media/plans");
}
