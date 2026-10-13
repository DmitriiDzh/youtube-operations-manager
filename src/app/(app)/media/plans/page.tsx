import { redirect } from "next/navigation";
import { MEDIA_DEFAULT_TAB } from "@/components/section-tabs";

// BL-184 stage 3 (owner, Telegram msgs 2741/2743): the Plans tab became the content of Media's kind tabs; its old address (bookmarks,
// older notices) leads to the first of them. A plan's review keeps its address (`plans/<planId>/review`).
export default function FormerPlansTab() {
  redirect(`/media/${MEDIA_DEFAULT_TAB}`);
}
