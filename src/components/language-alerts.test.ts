import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator } from "@/lib/ui-text";
import { languagesBadge, otherChannelLanguageEntries, type LanguageAlertChannel } from "./language-alerts";

// BL-178 part C (LOCALIZATION_BASELINE_PLAN §3.3 C2, FO-REQ-0022 §6): the badge on «Языки» is the active channel's; the bell
// names every other channel with the count and the missing languages, and the videos labelled with another language; nothing
// is shown once the counts are zero (the alert clears by itself). Expected texts written from the plan, not from the code.
const en = createTranslator("en");
const ru = createTranslator("ru");

const tropico: LanguageAlertChannel = { channelId: "UC_tropico", missingVideoCount: 2, missingByLanguage: { es: 2, "pt-BR": 1 }, deviationCount: 1 };
const japan: LanguageAlertChannel = { channelId: "UC_japan", missingVideoCount: 3, missingByLanguage: { es: 2, "pt-BR": 3 }, deviationCount: 1 };
const done: LanguageAlertChannel = { channelId: "UC_done", missingVideoCount: 0, missingByLanguage: {}, deviationCount: 0 };

test("the bell lists the other channels only: the missing languages, most missing first, and the mislabelled videos", () => {
  assert.deepEqual(otherChannelLanguageEntries(en, [tropico, japan, done], "UC_tropico"), [
    { key: "UC_japan:languages:missing", channelId: "UC_japan", text: "3 public or scheduled videos lack a translation: pt-BR (3), es (2)", href: "/languages" },
    { key: "UC_japan:languages:deviations", channelId: "UC_japan", text: "1 video is labelled with another language than the channel's", href: "/languages" },
  ]);
  assert.deepEqual(otherChannelLanguageEntries(en, [done], null), [], "nothing left: no entry");
});

test("the «Языки» badge counts the active channel's videos to look at, with what they are made of on hover", () => {
  assert.deepEqual(languagesBadge(en, tropico), { badge: 3, badgeTitle: "Without a translation: 2; labelled with another language: 1" });
  assert.deepEqual(languagesBadge(en, done), { badge: 0 });
  assert.deepEqual(languagesBadge(en, undefined), { badge: 0 });
});

test("Russian wording", () => {
  const [entry] = otherChannelLanguageEntries(ru, [{ ...japan, missingVideoCount: 5 }], null);
  assert.equal(entry.text, "5 публичных или запланированных видео без перевода: pt-BR (3), es (2)");
});
