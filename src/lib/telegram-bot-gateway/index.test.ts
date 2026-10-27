import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramBotGateway, fitTelegramText, redactTelegramToken, TelegramBotError } from "./index";

// BL-228 (SYSTEM_TOPIC_PLAN.md §2 item 1, AC-SYS-14): the Bot API calls as Telegram documents them (POST JSON to
// /bot<token>/<method>; getUpdates with offset, timeout and allowed_updates; sendMessage with chat_id, message_thread_id and plain
// text), and the token never in an error. No real network: every test injects its own fetch.

// A token-shaped secret (bot id, colon, 35 characters), as BotFather issues them.
const TOKEN = "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ";

type Call = { url: string; body: Record<string, unknown> };
function fakeFetch(answer: { status?: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    if (answer instanceof Error) throw answer;
    return { status: answer.status ?? 200, text: async () => JSON.stringify(answer.body) };
  };
  return { fetch, calls };
}

function assertNoToken(error: unknown) {
  assert.ok(error instanceof TelegramBotError, "a TelegramBotError");
  const everything = `${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;
  assert.ok(!everything.includes(TOKEN), "the token is not in the error");
  assert.ok(!everything.includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ"), "the secret part is not in the error");
}

test("getUpdates: POST to the token's getUpdates with offset, timeout and messages only; updates parsed", async () => {
  const { fetch, calls } = fakeFetch({
    body: {
      ok: true,
      result: [
        { update_id: 501, message: { message_id: 7, chat: { id: -1001234567890 }, message_thread_id: 42, from: { id: 331110302, is_bot: false, username: "owner" }, text: "status" } },
        { update_id: 502 },
      ],
    },
  });
  const gateway = createTelegramBotGateway({ fetch });
  const updates = await gateway.getUpdates(TOKEN, { offset: 501, timeoutSeconds: 25 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/getUpdates`);
  assert.deepEqual(calls[0].body, { offset: 501, timeout: 25, allowed_updates: ["message"] });
  assert.deepEqual(updates, [
    { updateId: 501, message: { messageId: 7, chatId: -1001234567890, threadId: 42, from: { id: 331110302, isBot: false, username: "owner" }, text: "status" } },
    { updateId: 502, message: null },
  ]);
});

test("getUpdates without a stored offset sends no offset", async () => {
  const { fetch, calls } = fakeFetch({ body: { ok: true, result: [] } });
  await createTelegramBotGateway({ fetch }).getUpdates(TOKEN, { offset: null, timeoutSeconds: 25 });
  assert.equal("offset" in calls[0].body, false);
});

test("sendMessage: chat id as given, the topic id, plain text cut to 4096 characters", async () => {
  const { fetch, calls } = fakeFetch({ body: { ok: true, result: { message_id: 99 } } });
  const result = await createTelegramBotGateway({ fetch }).sendMessage(TOKEN, { chatId: "-1001234567890", threadId: 42, text: "x".repeat(5000) });
  assert.deepEqual(result, { messageId: 99 });
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].body.chat_id, "-1001234567890");
  assert.equal(calls[0].body.message_thread_id, 42);
  assert.equal("parse_mode" in calls[0].body, false);
  const text = calls[0].body.text as string;
  assert.equal(text.length, 4096);
  assert.equal(text, `${"x".repeat(4095)}…`);
});

test("fitTelegramText never splits a character: 4096 emoji stay, 4097 become 4095 + …", () => {
  assert.equal(fitTelegramText("😀".repeat(4096)), "😀".repeat(4096));
  assert.equal(fitTelegramText("😀".repeat(4097)), `${"😀".repeat(4095)}…`);
});

test("a token that is not token-shaped is refused before any call", async () => {
  const { fetch, calls } = fakeFetch({ body: { ok: true, result: [] } });
  await assert.rejects(createTelegramBotGateway({ fetch }).getUpdates("not-a-token", { offset: null, timeoutSeconds: 25 }), (e: unknown) => e instanceof TelegramBotError && e.code === "telegram_token_invalid");
  assert.equal(calls.length, 0);
});

test("AC-SYS-14: a network failure whose message and cause carry the full URL leaves no token in the error", async () => {
  const cause = new Error(`connect ECONNREFUSED for https://api.telegram.org/bot${TOKEN}/getUpdates`);
  const failure = new TypeError(`fetch failed: https://api.telegram.org/bot${TOKEN}/getUpdates`, { cause });
  const { fetch } = fakeFetch(failure);
  const error = await createTelegramBotGateway({ fetch })
    .getUpdates(TOKEN, { offset: null, timeoutSeconds: 25 })
    .then(() => null, (e: unknown) => e);
  assertNoToken(error);
  assert.equal((error as TelegramBotError).code, "telegram_unreachable");
  assert.match((error as TelegramBotError).message, /bot<redacted>/);
});

test("AC-SYS-14: a refusal whose description echoes the token leaves no token in the error", async () => {
  const { fetch } = fakeFetch({ status: 401, body: { ok: false, error_code: 401, description: `Unauthorized: ${TOKEN}` } });
  const error = await createTelegramBotGateway({ fetch })
    .sendMessage(TOKEN, { chatId: "-100", threadId: null, text: "hi" })
    .then(() => null, (e: unknown) => e);
  assertNoToken(error);
  assert.equal((error as TelegramBotError).code, "telegram_http_error");
  assert.equal((error as TelegramBotError).status, 401);
});

test("redactTelegramToken removes the given token and any other token-shaped text", () => {
  assert.equal(redactTelegramToken(`a ${TOKEN} b`, TOKEN), "a <redacted> b");
  assert.equal(redactTelegramToken(`/bot${TOKEN}/x`), "/bot<redacted>/x");
  assert.equal(redactTelegramToken("no secret here"), "no secret here");
});
