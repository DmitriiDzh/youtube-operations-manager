export type ChannelNotActiveDetails = {
  channelId: string;
  activeChannelId: string | null;
};

export type ChannelAccessDependencies = {
  getSelectedChannelId(userId: string): Promise<string | null>;
  setSelectedChannelId(userId: string, channelId: string): Promise<void>;
};
