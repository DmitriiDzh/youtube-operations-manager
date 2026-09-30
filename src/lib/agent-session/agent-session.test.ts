import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db, getSelectedChannelId, setSelectedChannelId, users } from "@/lib/db";
import { createCliAuthService } from "@/lib/cli-auth/services";
import { createChannelAccessCore } from "@/lib/channel-access";
import { isDomainError } from "@/lib/video-metadata/contracts";
import { enterAgentSession, getAgentSession, withAgentSessionForTests } from "./index";

// docs/roadmap/plans/PHASE_12_PLAN.md §6 enforcement design + AC-P12-04/05/06. These run against
// the real db.ts singleton (redirected to a per-file temp database under the test runner) and the
// real channel-access / cli-auth services -- the two choke points every handler goes through.

const BOUND = { tokenId: "tok-1", channelId: "UC_BOUND", userId: "user-bound" };

async function seedUser(id: string, selectedChannelId: string | null) {
  await db.insert(users).values({ id, email: `${id}@example.com`, selectedChannelId }).onConflictDoUpdate({
    target: users.id,
    set: { selectedChannelId },
  });
}

async function storedSelection(id: string) {
  const [row] = await db.select({ selected: users.selectedChannelId }).from(users).where(eq(users.id, id));
  return row?.selected ?? null;
}

test("outside an agent session the stored selection is used unchanged", async () => {
  await seedUser("user-bound", "UC_OPERATOR_CHOICE");
  assert.equal(getAgentSession(), null);
  assert.equal(await getSelectedChannelId("user-bound"), "UC_OPERATOR_CHOICE");
});

test("AC-P12-06: in a session the bound channel is the selection for the bound user, null for anyone else", async () => {
  await seedUser("user-bound", "UC_OPERATOR_CHOICE");
  await seedUser("user-other", "UC_OTHER");
  await withAgentSessionForTests(BOUND, async () => {
    assert.equal(await getSelectedChannelId("user-bound"), "UC_BOUND");
    assert.equal(await getSelectedChannelId("user-other"), null);

    const access = createChannelAccessCore();
    assert.equal(await access.assertActiveChannel({ userId: "user-bound", channelId: "UC_BOUND" }), "UC_BOUND");
    for (const [userId, channelId] of [
      ["user-bound", "UC_OPERATOR_CHOICE"],
      ["user-other", "UC_OTHER"],
    ]) {
      await assert.rejects(access.assertActiveChannel({ userId, channelId }), (e: unknown) => isDomainError(e) && e.code === "CHANNEL_NOT_ACTIVE");
    }
  });
});

test("AC-P12-04: selection writes are silent no-ops in a session; the operator's stored selection survives", async () => {
  await seedUser("user-bound", "UC_OPERATOR_CHOICE");
  await withAgentSessionForTests(BOUND, async () => {
    await setSelectedChannelId("user-bound", "UC_ELSEWHERE");
    await createChannelAccessCore().activateChannel({ userId: "user-bound", channelId: "UC_ELSEWHERE" });
  });
  assert.equal(await storedSelection("user-bound"), "UC_OPERATOR_CHOICE");
});

test("AC-P12-05: credential resolution returns the bound identity and rejects any explicit ref", async () => {
  const service = createCliAuthService({
    storage: {
      async read() {
        throw new Error("auth-context.json must never be read in an agent session");
      },
      async write() {
        throw new Error("must not be written");
      },
      async clear() {
        throw new Error("must not be cleared");
      },
    } as never,
  });
  await withAgentSessionForTests(BOUND, async () => {
    assert.deepEqual(await service.resolveEffectiveCredentialRef({}), { userId: "user-bound" });
    for (const explicit of [{ userId: "user-other" }, { accessToken: "ya29.stolen" }]) {
      await assert.rejects(
        service.resolveEffectiveCredentialRef({ explicit: explicit as never }),
        (e: unknown) => isDomainError(e) && e.code === "AGENT_SESSION_CREDENTIAL_OVERRIDE"
      );
    }
  });
});

test("AC-P12-04: identity/session-switching cli-auth operations refuse in a session", async () => {
  const service = createCliAuthService();
  await withAgentSessionForTests(BOUND, async () => {
    const attempts: Array<() => Promise<unknown>> = [
      () => service.selectUser({ userId: "user-other" }),
      () => service.selectWriteChannel({ channelId: "UCaaaaaaaaaaaaaaaaaaaaaa" }),
      () => service.listKnownWriteChannels(),
      () => service.listUsers(),
      () => service.logout(),
      () => service.revoke({ userId: "user-other" }),
      () => service.login(),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt(), (e: unknown) => isDomainError(e) && e.code === "AGENT_SESSION_OPERATOR_ONLY");
    }
  });
});

// Review round 1 finding 1: whoami/write_context must report the token's identity and never read
// auth-context.json (which may name the operator's OTHER Google identity).
test("AC-P12-03/05: whoami in a session reports the bound identity without reading auth-context.json", async () => {
  await seedUser("user-bound", null);
  await seedUser("user-other", "UC_OTHER");
  const service = createCliAuthService({
    storage: {
      async read() {
        throw new Error("auth-context.json must never be read in an agent session");
      },
      async write() {
        throw new Error("must not be written");
      },
      async clear() {
        throw new Error("must not be cleared");
      },
    } as never,
  });
  await withAgentSessionForTests(BOUND, async () => {
    const result = await service.whoami();
    assert.equal(result.userId, "user-bound");
    assert.deepEqual(result.effectiveCredentialRef, { userId: "user-bound" });
    assert.equal(JSON.stringify(result).includes("user-other"), false);
  });
});

test("enterAgentSession can be entered once and never replaced", () => {
  enterAgentSession(BOUND);
  assert.throws(() => enterAgentSession({ ...BOUND, channelId: "UC_OTHER" }));
  assert.equal(getAgentSession()?.channelId, "UC_BOUND");
  assert.throws(() => {
    (getAgentSession() as { channelId: string }).channelId = "UC_OTHER";
  });
});
