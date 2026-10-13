"use client";

import { useParams, useRouter } from "next/navigation";
import { useAppChannel } from "@/components/app-channel";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { StoryboardReviewScreen } from "@/components/storyboard-review-screen";
import { useT } from "@/components/ui-text-provider";

// BL-184 (FO-REQ-0024 §4 B2): a storyboard's review screen at its own address (reload, bookmark, a bell entry), for the active
// channel; the Media panel stays mounted and hidden meanwhile.
export default function StoryboardReviewPage() {
  const { storyboardId } = useParams<{ storyboardId: string }>();
  const router = useRouter();
  const { channel } = useAppChannel();
  const t = useT();
  if (!channel) return null;
  return (
    <FeatureErrorBoundary label={t("page.storyboardReview")}>
      <StoryboardReviewScreen key={`${channel.id}:${storyboardId}`} channelId={channel.id} storyboardId={decodeURIComponent(storyboardId)} onClose={() => router.push("/media/storyboards")} />
    </FeatureErrorBoundary>
  );
}
