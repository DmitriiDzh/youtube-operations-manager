"use client";

import { createContext, useContext } from "react";

// BL-149 (docs/roadmap/plans/APP_ROUTES_PLAN.md): the active channel, read once by the `(app)` layout and shared with every
// section page (it used to be state of the single dashboard page).
export type ChannelInfo = {
  id: string;
  title: string;
  thumbnail?: string;
  videoCount?: string;
  subscriberCount?: string;
};

export type AppChannelState = {
  channel: ChannelInfo | null;
  /** The channel request failed (typically a stale Google sign-in). */
  channelUnavailable: boolean;
  /** Research's own summary updates the sidebar badge between the layout's polls. */
  setResearchPending(count: number): void;
};

const AppChannelContext = createContext<AppChannelState>({ channel: null, channelUnavailable: false, setResearchPending: () => undefined });

export const AppChannelProvider = AppChannelContext.Provider;

export function useAppChannel(): AppChannelState {
  return useContext(AppChannelContext);
}
