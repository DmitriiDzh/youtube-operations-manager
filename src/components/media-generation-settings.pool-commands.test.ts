import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator } from "@/lib/ui-text";
import type { CommandView } from "@/lib/media-jobs-pool/commands";
import { commandPending, commandStatusText, poolJobCancellable } from "./media-generation-settings";

// BL-188 stage 2 (SHARED_MEDIA_JOBS_PLAN.md §2.3/§2.5): what the owner reads after an action on another computer -- sent and
// waiting, that computer not reporting, done, a cancel of a job that had already ended, refused with the reason, an unanswered
// run that expired -- and which jobs offer Cancel at all (a Gemini job only before it is sent to Google).

const ru = createTranslator("ru");

function view(overrides: Partial<CommandView>): CommandView {
  return {
    commandId: "c1",
    kind: "cancel_job",
    targetDeviceId: "A",
    targetHostName: "Mac",
    targetOffline: false,
    targetUpdatedAt: "2026-10-14T12:00:00.000Z",
    source: "runpod",
    jobId: "mj_1",
    sessionId: null,
    channelId: "UC1",
    label: null,
    issuedAt: "2026-10-14T12:00:00.000Z",
    state: "waiting",
    code: null,
    createdJobId: null,
    resultAt: null,
    ...overrides,
  };
}

test("each state of a sent action reads as the plan's status line (ru)", () => {
  assert.match(commandStatusText(ru, view({})), /^Отмена: отправлено на Mac в .+ · ждёт подтверждения$/);
  assert.match(commandStatusText(ru, view({ targetOffline: true })), /^Отмена: Mac не на связи с .+ — выполнится, когда он появится$/);
  assert.equal(commandStatusText(ru, view({ state: "applying" })), "Отмена: выполняется на Mac");
  assert.match(commandStatusText(ru, view({ state: "applied", resultAt: "2026-10-14T12:01:00.000Z" })), /^Отмена: выполнено на Mac в /);
  assert.equal(commandStatusText(ru, view({ state: "applied", code: "already_finished" })), "Отмена: задание на Mac уже закончилось");
  assert.equal(commandStatusText(ru, view({ state: "refused", code: "media_limit_exceeded", kind: "create_job" })), "Запуск: отказано на Mac — превышен лимит того компьютера");
  // A code with no wording of its own is shown as it came, never dropped.
  assert.equal(commandStatusText(ru, view({ state: "refused", code: "media_template_not_found" })), "Отмена: отказано на Mac — код media_template_not_found");
  assert.match(commandStatusText(ru, view({ state: "expired", kind: "create_job" })), /^Запуск: Mac не принял его за 15 минут/);
  assert.match(commandStatusText(ru, view({ targetHostName: null })), /на Без имени/);
});

test("only a command still on its way is pending", () => {
  assert.equal(commandPending({ state: "waiting" }), true);
  assert.equal(commandPending({ state: "applying" }), true);
  for (const state of ["applied", "refused", "expired"] as const) assert.equal(commandPending({ state }), false);
});

test("Cancel is offered for an unfinished RunPod job and for a Gemini job not yet sent to Google only", () => {
  for (const status of ["queued", "submitted", "generating"]) assert.equal(poolJobCancellable({ source: "runpod", status }), true);
  for (const status of ["done", "failed", "cancelled"]) assert.equal(poolJobCancellable({ source: "runpod", status }), false);
  assert.equal(poolJobCancellable({ source: "gemini", status: "queued" }), true);
  for (const status of ["submitting", "running", "done", "failed"]) assert.equal(poolJobCancellable({ source: "gemini", status }), false);
});
