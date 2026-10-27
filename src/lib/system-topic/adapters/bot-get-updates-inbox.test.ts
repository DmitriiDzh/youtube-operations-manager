import assert from "node:assert/strict";
import test from "node:test";
import { createBotGetUpdatesInbox } from "./bot-get-updates-inbox";

// BL-228 (owner msg 3602): the `bot_get_updates` inbound source. Its cursor is the getUpdates offset as Telegram documents it (one
// past the newest update seen); an update below the offset is skipped; a message's fields map one to one; with no token stored it
// asks Telegram nothing. Fake getUpdates only -- no network.

const TOKEN = "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ";

test("asks with the cursor as offset and 25 s, returns the messages and one past the newest update", async () => {
  const calls: unknown[] = [];
  const stop = new AbortController();
  const inbox = createBotGetUpdatesInbox({
    readToken: async () => TOKEN,
    getUpdates: async (token, input) => {
      calls.push({ tokenIsGiven: token === TOKEN, ...input });
      return [
        { updateId: 9, message: null },
        { updateId: 10, message: { messageId: 5, chatId: -1001, threadId: 42, from: { id: 7, isBot: false, username: null }, text: "help" } },
        { updateId: 12, message: { messageId: 6, chatId: -1001, threadId: null, from: null, text: null } },
      ];
    },
  });
  const result = await inbox.receive({ cursor: 10, signal: stop.signal });
  assert.deepEqual(calls, [{ tokenIsGiven: true, offset: 10, timeoutSeconds: 25, signal: stop.signal }]);
  assert.deepEqual(result, {
    nextCursor: 13,
    messages: [
      { updateId: 10, messageId: 5, chatId: -1001, threadId: 42, fromId: 7, text: "help", date: null },
      { updateId: 12, messageId: 6, chatId: -1001, threadId: null, fromId: null, text: null, date: null },
    ],
  });
});

test("nothing new keeps the cursor; no token asks Telegram nothing", async () => {
  let asked = 0;
  const getUpdates = async () => (asked++, []);
  assert.deepEqual(await createBotGetUpdatesInbox({ readToken: async () => TOKEN, getUpdates }).receive({ cursor: 50 }), { messages: [], nextCursor: 50 });
  assert.deepEqual(await createBotGetUpdatesInbox({ readToken: async () => null, getUpdates }).receive({ cursor: 50 }), { messages: [], nextCursor: 50 });
  assert.equal(asked, 1);
});
