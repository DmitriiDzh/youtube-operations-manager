import { redirect } from "next/navigation";

// BL-149: Production opens on Sessions.
export default function ProductionIndex() {
  redirect("/production/sessions");
}
