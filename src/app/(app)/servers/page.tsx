import { redirect } from "next/navigation";

// BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-01): Servers opens on Sessions.
export default function ServersIndex() {
  redirect("/servers/sessions");
}
