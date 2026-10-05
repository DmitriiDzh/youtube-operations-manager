import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db, getSelectedChannelId, setSelectedChannelId, users } from "@/lib/db";
import { createCliAuthService } from "@/lib/cli-auth/services";
import { createChannelAccessCore } from "@/lib/channel-access";
import { isDomainError } from "@/lib/shared-domain";
import { assertAgentSession, getAgentSession, runInAgentSession, withAgentSessionForTests } from "./index";

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

// docs/decisions/0013-in-app-http-mcp-transport.md -- the scope is per request (AsyncLocalStorage),
// never process-wide. Expected values below are stated by hand from AC-HM-07/08/09.

const TOKEN_A = { tokenId: "tok-a", channelId: "UC_A", userId: "user-a" };
const TOKEN_B = { tokenId: "tok-b", channelId: "UC_B", userId: "user-b" };

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

test("AC-HM-09: no ambient scope exists outside a request's run, before and after it", async () => {
  assert.equal(getAgentSession(), null);
  await runInAgentSession(TOKEN_A, async () => {
    assert.equal(getAgentSession()?.channelId, "UC_A");
  });
  assert.equal(getAgentSession(), null);
});

test("AC-HM-07: concurrent requests for A, B and an operator path each see only their own scope", async () => {
  const seen: Record<string, Array<string | null>> = { a: [], b: [], operator: [] };
  const sample = (key: string) => seen[key].push(getAgentSession()?.channelId ?? null);

  await Promise.all([
    runInAgentSession(TOKEN_A, async () => {
      sample("a");
      await delay(30); // B and the operator run while A is suspended mid-request
      sample("a");
      await Promise.resolve().then(() => sample("a"));
    }),
    runInAgentSession(TOKEN_B, async () => {
      await delay(5);
      sample("b");
      await delay(40);
      sample("b");
    }),
    (async () => {
      await delay(10);
      sample("operator");
      await delay(40);
      sample("operator");
    })(),
  ]);

  assert.deepEqual(seen.a, ["UC_A", "UC_A", "UC_A"]);
  assert.deepEqual(seen.b, ["UC_B", "UC_B"]);
  assert.deepEqual(seen.operator, [null, null]);
});

test("AC-HM-07: the selection choke point is scoped per request too (A, B, operator interleaved)", async () => {
  await seedUser("user-a", "UC_A_STORED");
  await seedUser("user-b", "UC_B_STORED");
  const results: Record<string, string | null> = {};
  await Promise.all([
    runInAgentSession(TOKEN_A, async () => {
      await delay(20);
      results.a = await getSelectedChannelId("user-a");
      results.aForB = await getSelectedChannelId("user-b");
    }),
    runInAgentSession(TOKEN_B, async () => {
      results.b = await getSelectedChannelId("user-b");
    }),
    (async () => {
      await delay(10);
      results.operator = await getSelectedChannelId("user-a");
    })(),
  ]);
  assert.deepEqual(results, { a: "UC_A", aForB: null, b: "UC_B", operator: "UC_A_STORED" });
});

test("AC-HM-08: assertAgentSession refuses when the scope is absent or belongs to another token", async () => {
  assert.throws(() => assertAgentSession("tok-a"));
  await runInAgentSession(TOKEN_B, async () => {
    assert.throws(() => assertAgentSession("tok-a"));
    assert.equal(assertAgentSession("tok-b").channelId, "UC_B");
  });
});

test("AC-HM-08: a scope escaping into detached work never leaks into a sibling request", async () => {
  let detached: Promise<string | null> = Promise.resolve(null);
  await runInAgentSession(TOKEN_A, async () => {
    detached = delay(10).then(() => getAgentSession()?.channelId ?? null);
  });
  // Work started inside A's run keeps A's scope (never another's, never "operator").
  assert.equal(await detached, "UC_A");
  assert.equal(getAgentSession(), null);
});

test("the scope object is frozen", async () => {
  await runInAgentSession(TOKEN_A, async () => {
    assert.throws(() => {
      (getAgentSession() as { channelId: string }).channelId = "UC_OTHER";
    });
  });
});

test("withAgentSessionForTests(null) removes the scope even inside one", async () => {
  await runInAgentSession(TOKEN_A, async () => {
    await withAgentSessionForTests(null, async () => {
      assert.equal(getAgentSession(), null);
    });
    assert.equal(getAgentSession()?.channelId, "UC_A");
  });
});
