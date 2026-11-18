import { notFound, redirect } from "next/navigation";
import { contentSubTabRedirect, isSectionSubTab } from "@/components/section-tabs";

// BL-176: the content layout renders the sub-tab; this page gives it its address and answers an unknown one with a 404.
export default async function ContentSubTabPage({ params }: { params: Promise<{ sub: string }> }) {
  const { sub } = await params;
  // BL-241: «Клипы на проверку» moved to Media (owner msg 4025); BL-266: «Публикация» is part of «План». The old addresses lead there.
  const moved = contentSubTabRedirect(sub);
  if (moved) redirect(moved);
  if (!isSectionSubTab("content", sub)) notFound();
  return null;
}
