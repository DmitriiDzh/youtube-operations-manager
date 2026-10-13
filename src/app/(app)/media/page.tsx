import { redirect } from "next/navigation";
import { MEDIA_DEFAULT_TAB } from "@/components/section-tabs";

// BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-01): Media opens on its first tab -- «Музыка» since BL-184 stage 3 (was Plans).
export default function MediaIndex() {
  redirect(`/media/${MEDIA_DEFAULT_TAB}`);
}
