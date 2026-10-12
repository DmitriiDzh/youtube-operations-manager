import { notFound } from "next/navigation";
import { isSectionSubTab } from "@/components/section-tabs";

// BL-176: the content layout renders the sub-tab; this page gives it its address and answers an unknown one with a 404.
export default async function ContentSubTabPage({ params }: { params: Promise<{ sub: string }> }) {
  const { sub } = await params;
  if (!isSectionSubTab("content", sub)) notFound();
  return null;
}
