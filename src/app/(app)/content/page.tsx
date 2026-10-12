import { redirect } from "next/navigation";

// BL-176 (LIVE_STREAMS_PLAN.md §3.12): `/content` keeps opening «Видео».
export default function ContentIndex() {
  redirect("/content/videos");
}
