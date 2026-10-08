import assert from "node:assert/strict";
import test from "node:test";
import { errorText } from "@/lib/ui-text";
import { LiveLanguage } from "./ui-text-provider";

// BL-152 review round 4: switching the interface language must not give `t` a new identity -- components list `t` in
// their fetch callbacks' dependencies, and a new `t` would refetch every open panel and overwrite unsaved form drafts.
test("the provider's translator keeps its identity across a language change and follows the new language", () => {
  const live = new LiveLanguage("en");
  const { t, formatNumber } = live;
  assert.equal(t("common.save"), "Save");
  assert.equal(t.language, "en");
  live.set("ru");
  assert.equal(live.t, t);
  assert.equal(live.formatNumber, formatNumber);
  assert.equal(t("common.save"), "Сохранить");
  assert.equal(t.language, "ru");
  assert.equal(formatNumber(1234.5), "1 234,5");
  // Helpers given only `t` follow it too.
  assert.equal(errorText(t, { error: "connection_disabled" }, "x"), "Это подключение отключено.");
});
