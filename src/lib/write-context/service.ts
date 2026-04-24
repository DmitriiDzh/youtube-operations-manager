import { DomainError, type CredentialRef, type ResolvedCredentials } from "@/lib/video-metadata/contracts";
import type {
  AssertWriteChannelInput,
  AssertWriteChannelOutput,
  KnownWriteChannel,
  WriteChannelContext,
  WriteChannelInfo,
  WriteChannelSource,
} from "./contracts";

type WriteContextDependencies = {
  youtubeApi: {
    getActiveChannel(args: { credentials: ResolvedCredentials }): Promise<WriteChannelInfo | null>;
  };
  channelSelectionStore: {
    getSelectedChannelId(userId: string): Promise<string | null>;
    setSelectedChannelId(userId: string, channelId: string): Promise<void>;
  };
};

type ResolveExpectedChannelInput = {
  credentialRef: CredentialRef;
  explicitExpectedChannelId?: string;
};

type ResolvedExpectedChannel = {
  expectedChannelId: string | null;
  selectedChannelId: string | null;
  source: WriteChannelSource;
  userId: string | null;
};

function normalizeChannelId(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getCredentialUserId(credentialRef: CredentialRef): string | null {
  return "userId" in credentialRef ? credentialRef.userId : null;
}

export function createWriteContextService(deps: WriteContextDependencies) {
  function getAlignmentMessage(args: {
    status: "matched" | "mismatch" | "unresolved";
    expectedChannelId: string | null;
    activeWriteChannel: WriteChannelInfo | null;
  }) {
    if (args.status === "matched") {
      return {
        message: "Expected write channel is aligned with the active OAuth channel.",
        recommendedAction: null,
      };
    }

    if (args.status === "mismatch") {
      return {
        message:
          "Selected expected channel does not match the active OAuth channel. Persisted selection does not switch OAuth identity.",
        recommendedAction:
          "Reauthenticate with the expected channel or select the currently active OAuth channel.",
      };
    }

    if (!args.expectedChannelId) {
      return {
        message: "No expected write channel is configured yet.",
        recommendedAction: "Select the expected channel before running sensitive write operations.",
      };
    }

    if (!args.activeWriteChannel?.id) {
      return {
        message: "Expected write channel is configured but active OAuth channel could not be resolved.",
        recommendedAction: "Reauthenticate and verify the active OAuth channel, then retry.",
      };
    }

    return {
      message: "Write channel alignment is unresolved.",
      recommendedAction: "Inspect write context and retry with a valid selection.",
    };
  }

  function buildKnownChannels(args: {
    activeWriteChannel: WriteChannelInfo | null;
    selectedChannelId: string | null;
  }): KnownWriteChannel[] {
    const knownById = new Map<string, KnownWriteChannel>();

    if (args.selectedChannelId) {
      knownById.set(args.selectedChannelId, {
        id: args.selectedChannelId,
        title: null,
        source: "selected",
        isActive: false,
        isSelected: true,
      });
    }

    if (args.activeWriteChannel?.id) {
      const existing = knownById.get(args.activeWriteChannel.id);
      if (existing) {
        knownById.set(args.activeWriteChannel.id, {
          ...existing,
          title: args.activeWriteChannel.title,
          source: "active",
          isActive: true,
        });
      } else {
        knownById.set(args.activeWriteChannel.id, {
          id: args.activeWriteChannel.id,
          title: args.activeWriteChannel.title,
          source: "active",
          isActive: true,
          isSelected: false,
        });
      }
    }

    const activeEntries: KnownWriteChannel[] = [];
    const selectedEntries: KnownWriteChannel[] = [];

    for (const channel of knownById.values()) {
      if (channel.isActive) {
        activeEntries.push(channel);
      } else {
        selectedEntries.push(channel);
      }
    }

    return [...activeEntries, ...selectedEntries];
  }

  function deriveWriteChannelContext(args: {
    expectedChannelId: string | null;
    selectedChannelId: string | null;
    source: WriteChannelSource;
    activeWriteChannel: WriteChannelInfo | null;
  }): WriteChannelContext {
    const hasExpected = Boolean(args.expectedChannelId);
    const hasActive = Boolean(args.activeWriteChannel?.id);

    const status = hasExpected && hasActive
      ? args.expectedChannelId === args.activeWriteChannel?.id
        ? "matched"
        : "mismatch"
      : "unresolved";

    const requiresReauth =
      status === "mismatch"
        ? true
        : status === "unresolved" && hasExpected && !hasActive;

    const copy = getAlignmentMessage({
      status,
      expectedChannelId: args.expectedChannelId,
      activeWriteChannel: args.activeWriteChannel,
    });

    return {
      activeWriteChannel: args.activeWriteChannel,
      selectedChannelId: args.selectedChannelId,
      expectedChannelId: args.expectedChannelId,
      source: args.source,
      knownChannels: buildKnownChannels({
        activeWriteChannel: args.activeWriteChannel,
        selectedChannelId: args.selectedChannelId,
      }),
      alignment: {
        status,
        requiresReauth,
        message: copy.message,
        recommendedAction: copy.recommendedAction,
      },
      requiresReauth,
    };
  }

  async function resolveExpectedChannel(
    args: ResolveExpectedChannelInput
  ): Promise<ResolvedExpectedChannel> {
    const userId = getCredentialUserId(args.credentialRef);
    const selectedChannelId = userId
      ? normalizeChannelId(await deps.channelSelectionStore.getSelectedChannelId(userId))
      : null;

    const explicitExpectedChannelId = normalizeChannelId(args.explicitExpectedChannelId);
    if (explicitExpectedChannelId) {
      return {
        expectedChannelId: explicitExpectedChannelId,
        selectedChannelId,
        source: "explicit",
        userId,
      };
    }

    if (!userId) {
      return {
        expectedChannelId: null,
        selectedChannelId: null,
        source: "missing",
        userId: null,
      };
    }

    if (!selectedChannelId) {
      return {
        expectedChannelId: null,
        selectedChannelId: null,
        source: "missing",
        userId,
      };
    }

    return {
      expectedChannelId: selectedChannelId,
      selectedChannelId,
      source: "stored",
      userId,
    };
  }

  async function getActiveWriteChannel(args: { credentials?: ResolvedCredentials }) {
    if (!args.credentials) {
      return null;
    }

    return deps.youtubeApi.getActiveChannel({ credentials: args.credentials });
  }

  async function getWriteChannelContext(args: {
    credentialRef: CredentialRef;
    credentials?: ResolvedCredentials;
    expectedChannelId?: string;
  }): Promise<WriteChannelContext> {
    const [resolvedExpectedChannel, activeWriteChannel] = await Promise.all([
      resolveExpectedChannel({
        credentialRef: args.credentialRef,
        explicitExpectedChannelId: args.expectedChannelId,
      }),
      getActiveWriteChannel({ credentials: args.credentials }),
    ]);

    return deriveWriteChannelContext({
      activeWriteChannel,
      expectedChannelId: resolvedExpectedChannel.expectedChannelId,
      selectedChannelId: resolvedExpectedChannel.selectedChannelId,
      source: resolvedExpectedChannel.source,
    });
  }

  async function listKnownChannels(args: {
    credentialRef: CredentialRef;
    credentials?: ResolvedCredentials;
    expectedChannelId?: string;
  }) {
    const context = await getWriteChannelContext(args);
    return {
      knownChannels: context.knownChannels,
      alignment: context.alignment,
      activeWriteChannel: context.activeWriteChannel,
      selectedChannelId: context.selectedChannelId,
      expectedChannelId: context.expectedChannelId,
      source: context.source,
      requiresReauth: context.requiresReauth,
    };
  }

  async function selectWriteChannel(args: {
    credentialRef: CredentialRef;
    channelId: string;
    credentials?: ResolvedCredentials;
  }) {
    const userId = getCredentialUserId(args.credentialRef);
    if (!userId) {
      throw new DomainError({
        code: "validation_failed",
        message: "Write channel selection requires a userId credentialRef",
      });
    }

    const channelId = normalizeChannelId(args.channelId);
    if (!channelId) {
      throw new DomainError({
        code: "validation_failed",
        message: "Write channel selection requires a non-empty channelId",
      });
    }

    await deps.channelSelectionStore.setSelectedChannelId(userId, channelId);

    const context = await getWriteChannelContext({
      credentialRef: args.credentialRef,
      credentials: args.credentials,
    });

    return {
      selectedChannelId: context.selectedChannelId,
      activeWriteChannel: context.activeWriteChannel,
      expectedChannelId: context.expectedChannelId,
      source: context.source,
      alignment: context.alignment,
      knownChannels: context.knownChannels,
      requiresReauth: context.requiresReauth,
      message: context.alignment.message,
      recommendedAction: context.alignment.recommendedAction,
    };
  }

  async function assertWriteChannel(args: AssertWriteChannelInput): Promise<AssertWriteChannelOutput> {
    const context = await getWriteChannelContext({
      credentialRef: args.credentialRef,
      credentials: args.credentials,
      expectedChannelId: args.expectedChannelId,
    });

    if (!context.expectedChannelId) {
      throw new DomainError({
        code: "WRITE_CHANNEL_REQUIRED",
        message: "Missing expectedChannelId for a sensitive write operation",
        details: {
          source: context.source,
          userId: getCredentialUserId(args.credentialRef),
        },
      });
    }

    if (!context.activeWriteChannel?.id) {
      const recommendedAction =
        context.alignment.recommendedAction ??
        "Reauthenticate and verify the active OAuth channel, then retry.";
      throw new DomainError({
        code: "WRITE_CHANNEL_UNRESOLVED",
        message: "Cannot resolve active write channel for the current OAuth session",
        details: {
          expectedChannelId: context.expectedChannelId,
          activeWriteChannelId: null,
          requiresReauth: context.alignment.requiresReauth,
          recommendedAction,
          alignmentStatus: "unresolved",
        },
      });
    }

    if (context.activeWriteChannel.id !== context.expectedChannelId) {
      const recommendedAction =
        context.alignment.recommendedAction ??
        "Reauthenticate with the expected channel or select the currently active OAuth channel.";
      throw new DomainError({
        code: "WRITE_CHANNEL_MISMATCH",
        message: "expectedChannelId does not match the active write channel",
        details: {
          expectedChannelId: context.expectedChannelId,
          activeWriteChannelId: context.activeWriteChannel.id,
          requiresReauth: true,
          recommendedAction,
          alignmentStatus: "mismatch",
        },
      });
    }

    return {
      context,
      expectedChannelId: context.expectedChannelId,
      activeWriteChannel: context.activeWriteChannel,
      shouldPersistSelection: Boolean(getCredentialUserId(args.credentialRef)),
      userId: getCredentialUserId(args.credentialRef),
    };
  }

  return {
    deriveWriteChannelContext,
    resolveExpectedChannel,
    getActiveWriteChannel,
    getWriteChannelContext,
    listKnownChannels,
    selectWriteChannel,
    assertWriteChannel,
  };
}

export type WriteContextService = ReturnType<typeof createWriteContextService>;
