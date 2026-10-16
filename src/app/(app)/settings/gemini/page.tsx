import { redirect } from "next/navigation";

// BL-193 (owner, Telegram 2026-10-16, msgs 2864/2867): RunPod and Gemini share one Settings sub-tab, «Облачные API»; the old
// address (bookmarks, older notices and texts) leads there.
export default function FormerGeminiSettingsTab() {
  redirect("/settings/cloud-apis");
}
