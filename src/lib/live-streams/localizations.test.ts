import assert from "node:assert/strict";
import test from "node:test";
import { SUPPORTED_YOUTUBE_LANGUAGES } from "@/lib/youtube-supported-languages";
import { DomainError } from "./contracts";
import { createStreamLocalizations, readStoredLocalizations, validateLiveLocalizations } from "./localizations";
import type { StoredStreamRow } from "./services";

// BL-207 stage 2 (docs/roadmap/plans/LIVE_LOCALIZATIONS_PLAN.md §2 stage 2, AC-LL-07). Expected values by hand from the plan and
// the YouTube videos resource: a title is 1–100 characters (trimmed), a description 1–5000 BYTES (required: blank refused, owner msg 3287), neither holds < or >;
// a language is an exact supported YouTube code and never the channel's baseline; at most 50 languages; one bad entry refuses the
// whole set and nothing is stored.

const baseline = { baselineLanguage: "en" };
const entry = (title = "Titel", description = "Beschreibung") => ({ title, description });

test("AC-LL-07: a valid set is accepted, the title stored trimmed and the description as given", () => {
  const result = validateLiveLocalizations({ de: entry("  Jazz Radio 24/7  ", " Beschreibung \n"), "pt-BR": entry("Rádio", "x") }, baseline);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.set, { de: { title: "Jazz Radio 24/7", description: " Beschreibung \n" }, "pt-BR": { title: "Rádio", description: "x" } });
});

test("AC-LL-07: the title must be 1–100 characters after trimming (code points, not UTF-16 units)", () => {
  assert.equal(validateLiveLocalizations({ de: entry("x".repeat(100)) }, baseline).ok, true);
  // 100 emoji = 100 characters (200 UTF-16 units): YouTube counts characters.
  assert.equal(validateLiveLocalizations({ de: entry("🎷".repeat(100)) }, baseline).ok, true);
  for (const title of ["", "   ", "x".repeat(101)]) {
    const result = validateLiveLocalizations({ de: entry(title) }, baseline);
    assert.equal(result.ok, false, JSON.stringify(title));
    if (result.ok) continue;
    assert.deepEqual(result.refused.map((r) => [r.language, r.reason]), [["de", title.length > 100 ? "title_too_long" : "title_empty"]]);
  }
});

test("AC-LL-07: the description is at most 5000 bytes: 2500 × é (5000 bytes) accepted, 2501 × é (5002 bytes) refused", () => {
  assert.equal(validateLiveLocalizations({ de: entry("T", "é".repeat(2500)) }, baseline).ok, true);
  assert.equal(validateLiveLocalizations({ de: entry("T", "a".repeat(5000)) }, baseline).ok, true);
  for (const description of ["é".repeat(2501), "a".repeat(5001)]) {
    const result = validateLiveLocalizations({ de: entry("T", description) }, baseline);
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.deepEqual(result.refused.map((r) => [r.language, r.reason]), [["de", "description_too_long"]]);
  }
});

test("AC-LL-07 (owner msg 3287): the description is required -- empty or blank refused, \"x\" accepted, 1..5000 bytes", () => {
  for (const description of ["", "   "]) {
    const result = validateLiveLocalizations({ de: entry("T", description) }, baseline);
    assert.equal(result.ok, false, JSON.stringify(description));
    if (result.ok) continue;
    assert.deepEqual(result.refused.map((r) => [r.language, r.reason]), [["de", "description_empty"]]);
  }
  assert.equal(validateLiveLocalizations({ de: entry("T", "x") }, baseline).ok, true);
  assert.equal(validateLiveLocalizations({ de: entry("T", "é".repeat(2500)) }, baseline).ok, true);
  const tooLong = validateLiveLocalizations({ de: entry("T", "é".repeat(2501)) }, baseline);
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.deepEqual(tooLong.refused.map((r) => r.reason), ["description_too_long"]);
});

test("AC-LL-07: < or > in the title or the description is refused", () => {
  const title = validateLiveLocalizations({ de: entry("Jazz <live>") }, baseline);
  assert.equal(title.ok, false);
  if (!title.ok) assert.deepEqual(title.refused.map((r) => r.reason), ["title_angle_brackets"]);
  const description = validateLiveLocalizations({ de: entry("Jazz", "a > b") }, baseline);
  assert.equal(description.ok, false);
  if (!description.ok) assert.deepEqual(description.refused.map((r) => r.reason), ["description_angle_brackets"]);
});

test("AC-LL-07: a language must be an exact supported code -- pt-br is refused with the hint pt-BR, xx without a hint", () => {
  const result = validateLiveLocalizations({ "pt-br": entry(), xx: entry(), de: entry() }, baseline);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(
    result.refused.map((r) => ({ language: r.language, reason: r.reason, hint: r.hint })),
    [
      { language: "pt-br", reason: "unsupported_language", hint: "pt-BR" },
      { language: "xx", reason: "unsupported_language", hint: undefined },
    ]
  );
  assert.match(result.refused[0].message, /pt-BR/);
});

test("AC-LL-02 (save): the channel's baseline language is refused, in any letter case", () => {
  for (const language of ["en"]) {
    const result = validateLiveLocalizations({ [language]: entry(), de: entry() }, baseline);
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.refused.map((r) => [r.language, r.reason]), [["en", "baseline_language"]]);
  }
  // A regional variant is its own language, not the baseline.
  assert.equal(validateLiveLocalizations({ "en-GB": entry() }, baseline).ok, true);
  // With baseline "pt-BR", the code itself is refused as the baseline.
  const regional = validateLiveLocalizations({ "pt-BR": entry() }, { baselineLanguage: "pt-br" });
  assert.equal(regional.ok, false);
  if (!regional.ok) assert.deepEqual(regional.refused.map((r) => r.reason), ["baseline_language"]);
});

test("AC-LL-07: 50 languages are accepted, 51 refused as a whole", () => {
  const codes = SUPPORTED_YOUTUBE_LANGUAGES.map((l) => l.code).filter((code) => code !== "en");
  const of = (n: number) => Object.fromEntries(codes.slice(0, n).map((code) => [code, entry()]));
  assert.equal(validateLiveLocalizations(of(50), baseline).ok, true);
  const result = validateLiveLocalizations(of(51), baseline);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.problem, "too_many_languages");
});

test("validation: the input must be an object of {title, description} entries, nothing else", () => {
  for (const input of [null, [], "de", { de: "Titel" }, { de: { title: "T" } }, { de: { title: "T", description: "D", tags: [] } }, { de: { title: 1, description: "D" } }]) {
    assert.equal(validateLiveLocalizations(input, baseline).ok, false, JSON.stringify(input));
  }
  // An empty set is valid: it clears the stored one.
  const empty = validateLiveLocalizations({}, baseline);
  assert.equal(empty.ok, true);
  if (empty.ok) assert.deepEqual(empty.set, {});
});

test("readStoredLocalizations: null = none saved; a stored value that no longer passes is reported, never guessed", () => {
  assert.deepEqual(readStoredLocalizations(null), { ok: true, set: null });
  assert.deepEqual(readStoredLocalizations(undefined), { ok: true, set: null });
  assert.deepEqual(readStoredLocalizations('{"de":{"title":"T","description":"D"}}'), { ok: true, set: { de: { title: "T", description: "D" } } });
  assert.equal(readStoredLocalizations("{not json").ok, false);
  assert.equal(readStoredLocalizations('{"de":{"title":"","description":"D"}}').ok, false);
  assert.equal(readStoredLocalizations('{"pt-br":{"title":"T","description":"D"}}').ok, false);
});

// --- the store (replace semantics; a refused call stores nothing) --------------------------------------------------------------

function fakeStore(initial: Partial<StoredStreamRow> | null) {
  let row = initial ? ({ channelId: "UC1", localizationsJson: null, ...initial } as Partial<StoredStreamRow>) : null;
  const updates: Array<Record<string, unknown>> = [];
  const events: Array<{ kind: string; detail: unknown }> = [];
  return {
    updates,
    events,
    row: () => row,
    store: {
      async getStream() {
        return row as StoredStreamRow | null;
      },
      async updateStream(_channelId: string, set: Record<string, unknown>) {
        if (!row) return false;
        updates.push(set);
        row = { ...row, ...set };
        return true;
      },
      async insertEvent(event: { kind: string; detailJson: string }) {
        events.push({ kind: event.kind, detail: JSON.parse(event.detailJson) });
      },
    },
  };
}

function service(fake: ReturnType<typeof fakeStore>, channelLanguage: string | null = "en") {
  return createStreamLocalizations({ store: fake.store, channelLanguage: async () => channelLanguage, clock: () => new Date("2026-10-21T10:00:00Z"), newId: () => "id" });
}

test("store: saving replaces the stored set, and get returns it", async () => {
  const fake = fakeStore({ localizationsJson: JSON.stringify({ fr: { title: "Ft", description: "Fd" } }) });
  const saved = await service(fake).set("UC1", { de: entry("Dt", "Dd") });
  assert.deepEqual(saved, { de: { title: "Dt", description: "Dd" } });
  assert.deepEqual(JSON.parse(fake.row()!.localizationsJson as string), { de: { title: "Dt", description: "Dd" } });
  assert.deepEqual(await service(fake).get("UC1"), { ok: true, set: { de: { title: "Dt", description: "Dd" } } });
  assert.deepEqual(fake.events.map((e) => e.kind), ["localizations_saved"]);
});

test("store: an empty set clears the stored one (null)", async () => {
  const fake = fakeStore({ localizationsJson: JSON.stringify({ fr: { title: "Ft", description: "Fd" } }) });
  assert.deepEqual(await service(fake).set("UC1", {}), {});
  assert.equal(fake.row()!.localizationsJson, null);
  assert.deepEqual(await service(fake).get("UC1"), { ok: true, set: null });
});

test("AC-LL-07: a refused call stores nothing (one bad language among good ones)", async () => {
  const before = JSON.stringify({ fr: { title: "Ft", description: "Fd" } });
  const fake = fakeStore({ localizationsJson: before });
  await assert.rejects(
    () => service(fake).set("UC1", { de: entry(), it: entry("x".repeat(101)), es: entry() }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed" && JSON.stringify(error.details).includes("title_too_long")
  );
  assert.deepEqual(fake.updates, []);
  assert.equal(fake.row()!.localizationsJson, before);
  // The baseline is the channel's: "en" is refused at save.
  await assert.rejects(() => service(fake).set("UC1", { en: entry() }), (error: unknown) => error instanceof DomainError && JSON.stringify(error.details).includes("baseline_language"));
  assert.deepEqual(fake.updates, []);
});

test("store: a channel without a stream here is refused (nothing created)", async () => {
  const fake = fakeStore(null);
  await assert.rejects(() => service(fake).set("UC1", { de: entry() }), (error: unknown) => error instanceof DomainError && error.code === "not_found");
  assert.equal(fake.row(), null);
});
