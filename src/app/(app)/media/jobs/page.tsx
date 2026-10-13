import { redirect } from "next/navigation";
import { MEDIA_DEFAULT_TAB } from "@/components/section-tabs";

// BL-184 stage 3 (owner, Telegram msgs 2741/2743): the Jobs tab became part of Media's kind tabs (each lists the jobs of its kind);
// its old address leads to the first of them.
export default function FormerJobsTab() {
  redirect(`/media/${MEDIA_DEFAULT_TAB}`);
}
