import { redirect } from "next/navigation";
import { productionRedirectTarget } from "@/components/section-tabs";

// BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-02): Production was split into Media and Servers. An old address -- a bookmark, a
// remembered sidebar path, a link -- lands on the same place in its new section, with its query.
export default async function ProductionRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ rest?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ rest }, query] = await Promise.all([params, searchParams]);
  redirect(productionRedirectTarget(rest, query));
}
