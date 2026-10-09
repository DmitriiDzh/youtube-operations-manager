"use client";

import { useRouter, useSelectedLayoutSegments } from "next/navigation";
import type { ReactNode } from "react";
import { useAppChannel } from "@/components/app-channel";
import { SERVERS_TABS, ServersPanel } from "@/components/production-panel";
import { FeatureErrorBoundary } from "@/components/feature-error-boundary";
import { useT } from "@/components/ui-text-provider";

// BL-157 (SERVERS_MEDIA_PLAN.md AC-SM-01): Servers at `/servers/<sub-tab>` -- the shared infrastructure, the same for every
// channel (the active channel only marks "this channel" and is the channel a session request is for).
export default function ServersLayout({ children }: { children: ReactNode }) {
  const { channel } = useAppChannel();
  const router = useRouter();
  const t = useT();
  const segment = useSelectedLayoutSegments()[0] ?? null;
  const tab = SERVERS_TABS.find((item) => item.value === segment)?.value;
  return (
    <>
      {tab && (
        <FeatureErrorBoundary label={t("nav.servers")}>
          <ServersPanel activeChannelId={channel?.id ?? null} tab={tab} onTabChange={(next) => router.push(`/servers/${next}`)} />
        </FeatureErrorBoundary>
      )}
      {children}
    </>
  );
}
