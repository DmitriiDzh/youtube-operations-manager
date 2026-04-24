import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import {
  parseWithSchema,
  playlistAddVideosInputSchema,
  playlistAddVideosOutputSchema,
  playlistCreateInputSchema,
  playlistDeleteInputSchema,
  playlistDeleteOutputSchema,
  playlistRemoveVideosOutputSchema,
  playlistUpdateInputSchema,
  playlistUpdateOutputSchema,
} from "./schemas";

test("playlist add schema rejects invalid payload with typed validation error", () => {
  assert.throws(
    () => {
      parseWithSchema(
        playlistAddVideosInputSchema,
        {
          credentialRef: { userId: "" },
          playlistId: "playlist-1",
          videoIds: [],
        },
        "playlist add videos input"
      );
    },
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "validation_failed");
      assert.match(error.message, /Invalid playlist add videos input/);
      assert.ok(Array.isArray(error.details));
      return true;
    }
  );
});

test("playlist add output keeps stable shape", () => {
  const result = parseWithSchema(
    playlistAddVideosOutputSchema,
    {
      playlistId: "playlist-1",
      attempted: 3,
      added: 2,
      failures: [
        {
          videoId: "v2",
          reason: "already-present",
          message: "already in playlist",
        },
      ],
    },
    "playlist add videos output"
  );

  assert.deepEqual(result, {
    playlistId: "playlist-1",
    attempted: 3,
    added: 2,
    failures: [
      {
        videoId: "v2",
        reason: "already-present",
        message: "already in playlist",
      },
    ],
  });
});

test("playlist remove output keeps stable shape", () => {
  const result = parseWithSchema(
    playlistRemoveVideosOutputSchema,
    {
      playlistId: "playlist-1",
      requested: 2,
      removed: 1,
      failures: [{ videoId: "v2", reason: "not-found-in-playlist" }],
    },
    "playlist remove videos output"
  );

  assert.deepEqual(result, {
    playlistId: "playlist-1",
    requested: 2,
    removed: 1,
    failures: [{ videoId: "v2", reason: "not-found-in-playlist" }],
  });
});

test("playlist delete input/output keep stable contracts", () => {
  const parsedInput = parseWithSchema(
    playlistDeleteInputSchema,
    {
      credentialRef: { userId: "user-1" },
      playlistId: "playlist-1",
      expectedChannelId: "UC_ACTIVE",
    },
    "playlist delete input"
  );

  assert.deepEqual(parsedInput, {
    credentialRef: { userId: "user-1" },
    playlistId: "playlist-1",
    expectedChannelId: "UC_ACTIVE",
  });

  const parsedOutput = parseWithSchema(
    playlistDeleteOutputSchema,
    {
      deleted: true,
      playlistId: "playlist-1",
    },
    "playlist delete output"
  );

  assert.deepEqual(parsedOutput, {
    deleted: true,
    playlistId: "playlist-1",
  });
});

test("playlist delete schema rejects invalid payload with actionable details", () => {
  assert.throws(
    () => {
      parseWithSchema(
        playlistDeleteInputSchema,
        {
          credentialRef: { userId: "user-1" },
          playlistId: "",
          expectedChannelId: "",
        },
        "playlist delete input"
      );
    },
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "validation_failed");
      assert.match(error.message, /Invalid playlist delete input/);

      const details = error.details as Array<{ path: string }>;
      assert.equal(Array.isArray(details), true);
      assert.equal(details.some((detail) => detail.path === "playlistId"), true);
      assert.equal(details.some((detail) => detail.path === "expectedChannelId"), true);
      return true;
    }
  );
});

test("playlist create schema accepts optional description", () => {
  const parsedInput = parseWithSchema(
    playlistCreateInputSchema,
    {
      credentialRef: { userId: "user-1" },
      title: "Roadtrip",
      description: "Summer videos",
      expectedChannelId: "UC_ACTIVE",
    },
    "playlist create input"
  );

  assert.deepEqual(parsedInput, {
    credentialRef: { userId: "user-1" },
    title: "Roadtrip",
    description: "Summer videos",
    privacyStatus: "private",
    expectedChannelId: "UC_ACTIVE",
  });
});

test("playlist update schema rejects empty patch with actionable message", () => {
  assert.throws(
    () => {
      parseWithSchema(
        playlistUpdateInputSchema,
        {
          credentialRef: { userId: "user-1" },
          playlistId: "playlist-1",
          expectedChannelId: "UC_ACTIVE",
        },
        "playlist update input"
      );
    },
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "validation_failed");
      assert.match(error.message, /Invalid playlist update input/);
      const details = error.details as Array<{ message: string }>;
      assert.equal(
        details.some((detail) =>
          detail.message.includes("At least one mutable field is required")
        ),
        true
      );
      return true;
    }
  );
});

test("playlist update output keeps full metadata shape", () => {
  const parsedOutput = parseWithSchema(
    playlistUpdateOutputSchema,
    {
      playlist: {
        id: "playlist-1",
        title: "Roadtrip",
        description: "Summer videos",
        privacyStatus: "unlisted",
      },
    },
    "playlist update output"
  );

  assert.deepEqual(parsedOutput, {
    playlist: {
      id: "playlist-1",
      title: "Roadtrip",
      description: "Summer videos",
      privacyStatus: "unlisted",
    },
  });
});
