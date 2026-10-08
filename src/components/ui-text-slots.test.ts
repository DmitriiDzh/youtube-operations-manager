import assert from "node:assert/strict";
import test from "node:test";
import { isValidElement } from "react";
import { createTranslator } from "@/lib/ui-text";
import { translateWithSlots } from "./ui-text-provider";

// BL-152: an element (a highlighted number, a reset time) sits inside ONE translated sentence, where each language's
// grammar puts it -- the sentence is never glued together from translated fragments.
test("translateWithSlots puts each element where the language's sentence has its placeholder", () => {
  const parts = (language: "en" | "ru") =>
    translateWithSlots(createTranslator(language), "quota.bar.resets", {}, { time: "<TIME>" }).map((p) =>
      isValidElement(p) ? (p.props as { children: unknown }).children : p
    );
  const en = parts("en").join("");
  const ru = parts("ru").join("");
  assert.ok(en.includes("<TIME>") && ru.includes("<TIME>"));
  assert.notEqual(en, ru);
  assert.equal(parts("en").filter((p) => p === "<TIME>").length, 1);
});
