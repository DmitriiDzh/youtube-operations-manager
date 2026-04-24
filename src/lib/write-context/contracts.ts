import type { CredentialRef, DomainErrorCode, ResolvedCredentials } from "@/lib/video-metadata/contracts";

export type WriteChannelSource = "explicit" | "stored" | "missing";

export type WriteChannelInfo = {
  id: string;
  title: string | null;
};

export type WriteChannelAlignmentStatus = "matched" | "mismatch" | "unresolved";

export type WriteChannelAlignment = {
  status: WriteChannelAlignmentStatus;
  requiresReauth: boolean;
  message: string;
  recommendedAction: string | null;
};

export type KnownWriteChannel = {
  id: string;
  title: string | null;
  source: "active" | "selected";
  isActive: boolean;
  isSelected: boolean;
};

export type WriteChannelContext = {
  activeWriteChannel: WriteChannelInfo | null;
  selectedChannelId: string | null;
  expectedChannelId: string | null;
  source: WriteChannelSource;
  knownChannels: KnownWriteChannel[];
  alignment: WriteChannelAlignment;
  requiresReauth: boolean;
};

export type WriteChannelGuardrailCode =
  | "WRITE_CHANNEL_REQUIRED"
  | "WRITE_CHANNEL_MISMATCH"
  | "WRITE_CHANNEL_UNRESOLVED";

export type WriteChannelRequiredDetails = {
  source: WriteChannelSource;
  userId: string | null;
};

export type WriteChannelMismatchDetails = {
  expectedChannelId: string;
  activeWriteChannelId: string;
  requiresReauth: true;
  recommendedAction: string;
  alignmentStatus: "mismatch";
};

export type WriteChannelUnresolvedDetails = {
  expectedChannelId: string;
  activeWriteChannelId: string | null;
  requiresReauth: boolean;
  recommendedAction: string;
  alignmentStatus: "unresolved";
};

export type WriteChannelGuardrailDetails =
  | WriteChannelRequiredDetails
  | WriteChannelMismatchDetails
  | WriteChannelUnresolvedDetails;

export type AssertWriteChannelInput = {
  credentialRef: CredentialRef;
  credentials: ResolvedCredentials;
  expectedChannelId?: string;
};

export type AssertWriteChannelOutput = {
  context: WriteChannelContext;
  expectedChannelId: string;
  activeWriteChannel: WriteChannelInfo;
  shouldPersistSelection: boolean;
  userId: string | null;
};

export type WriteChannelErrorShape = {
  code: WriteChannelGuardrailCode;
  message: string;
  details: WriteChannelGuardrailDetails;
};

export type ExtendedDomainErrorCode = DomainErrorCode | WriteChannelGuardrailCode;
