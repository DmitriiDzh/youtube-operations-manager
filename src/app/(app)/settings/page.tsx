import { redirect } from "next/navigation";

// BL-149: Settings opens on General.
export default function SettingsIndex() {
  redirect("/settings/general");
}
