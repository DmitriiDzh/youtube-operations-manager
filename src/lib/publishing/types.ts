// Shapes this module shares with the gateways, restated so the module's contracts do not import a gateway (AGENTS.md §M).
export type VideoInsertResource = {
  snippet: { title: string; description: string; tags?: string[]; categoryId?: string; defaultLanguage?: string; defaultAudioLanguage?: string };
  status: {
    privacyStatus: "private";
    publishAt?: string;
    selfDeclaredMadeForKids: boolean;
    containsSyntheticMedia?: boolean;
    license?: "youtube" | "creativeCommon";
    embeddable?: boolean;
  };
};

export type UploadProgress = { done: true; videoId: string } | { done: false; storedBytes: number } | { expired: true };

export type VideoUploadStateView = {
  title: string | null;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  privacyStatus: string | null;
  publishAt: string | null;
  uploadStatus: string | null;
  failureReason: string | null;
  rejectionReason: string | null;
  selfDeclaredMadeForKids: boolean | null;
  containsSyntheticMedia: boolean | null;
  processingStatus: string | null;
};
