import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { startVisibleInterval, type VisibilityLike } from "./visible-interval";

// BL-270 (owner TG 4662/4665): the sidebar badges and the operation-lock poll ask the server nothing while the tab is hidden, and
// ask at once when it is shown again.

function fakeDocument(hidden: boolean) {
  const listeners = new Set<() => void>();
  const doc = {
    hidden,
    addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
  };
  return {
    doc: doc as unknown as VisibilityLike,
    setHidden(value: boolean) {
      doc.hidden = value;
      for (const fn of listeners) fn();
    },
    listeners,
  };
}

test("BL-270: polls while visible, not at all while hidden, once at once on becoming visible, then on the interval again", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const page = fakeDocument(false);
    let calls = 0;
    const stop = startVisibleInterval(() => calls++, 10_000, page.doc);
    mock.timers.tick(30_000);
    assert.equal(calls, 3);
    page.setHidden(true);
    mock.timers.tick(10 * 60_000);
    assert.equal(calls, 3, "hidden: nothing");
    page.setHidden(false);
    assert.equal(calls, 4, "shown: one read at once");
    mock.timers.tick(10_000);
    assert.equal(calls, 5);
    stop();
    mock.timers.tick(60_000);
    assert.equal(calls, 5, "stopped");
    assert.equal(page.listeners.size, 0, "listener removed");
  } finally {
    mock.timers.reset();
  }
});

test("BL-270: a tab opened in the background starts polling only once shown; a repeated 'visible' event does not double the timer", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const page = fakeDocument(true);
    let calls = 0;
    const stop = startVisibleInterval(() => calls++, 10_000, page.doc);
    mock.timers.tick(60_000);
    assert.equal(calls, 0);
    page.setHidden(false);
    page.setHidden(false);
    assert.equal(calls, 1);
    mock.timers.tick(10_000);
    assert.equal(calls, 2, "one timer, not two");
    stop();
  } finally {
    mock.timers.reset();
  }
});
