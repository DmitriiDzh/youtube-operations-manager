"use client";

import { errorText } from "@/lib/ui-text";
import { useCallback, useEffect, useState } from "react";
import { OperationOverlay, useOperation, LoadingIndicator } from "./operation-progress";
import { ConfirmDialog } from "./confirm-dialog";
import { ExperimentArmsPanel } from "./experiment-arms-panel";
import { ToggleSwitch } from "./toggle-switch";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import {
  EXPERIMENT_STATUS_TRANSITIONS as NEXT_STATUSES,
  EXPERIMENT_OUTCOME_RECORDABLE_STATUSES as OUTCOME_RECORDABLE_STATUSES,
  type ExperimentStatus,
} from "@/lib/decision-engine/status";
import type { ChannelInfo } from "@/components/app-channel";
import type { UiTextKey } from "@/lib/ui-text";
import { useT } from "./ui-text-provider";

type Hypothesis = {
  hypothesisId: string;
  channelId: string | null;
  statement: string;
  evidenceNotes: string;
  createdBy: string;
  createdVia: string;
  createdAt: string;
};

type Experiment = {
  experimentId: string;
  hypothesisId: string;
  treatment: string;
  controlBaseline: string;
  successCriteria: string;
  stoppingCriteria: string;
  responsible: string;
  status: ExperimentStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  changeSetId: string | null;
  executionBatchId: string | null;
  createdVia: string;
  createdAt: string;
};

type ExperimentOutcome = {
  outcomeId: string;
  experimentId: string;
  recordedBy: string;
  recordedAt: string;
  outcomeData: string;
  dataQualityLimitations: string | null;
  criteriaMet: "met" | "not_met" | "inconclusive";
  lessonsLearned: string | null;
  createdVia: string;
};

type EvidenceSourceType = "phase8_metric" | "phase9_channel_snapshot" | "phase9_video_snapshot" | "phase9_trend_candidate";

type HypothesisEvidence = {
  evidenceId: string;
  hypothesisId: string;
  reference: { sourceType: EvidenceSourceType } & Record<string, string>;
  note: string | null;
  createdVia: string;
  createdAt: string;
};

const EVIDENCE_SOURCE_TYPE_LABELS: Record<EvidenceSourceType, UiTextKey> = {
  phase8_metric: "decisions.evidenceSource.phase8Metric",
  phase9_channel_snapshot: "decisions.evidenceSource.phase9ChannelSnapshot",
  phase9_video_snapshot: "decisions.evidenceSource.phase9VideoSnapshot",
  phase9_trend_candidate: "decisions.evidenceSource.phase9TrendCandidate",
};

// BL-152: an experiment's state (badge) and the button that moves it there; Russian distinguishes «Одобрено» from «Одобрить».
const CRITERIA_LABELS: Record<ExperimentOutcome["criteriaMet"], UiTextKey> = {
  met: "decisions.criteria.met",
  not_met: "decisions.criteria.notMet",
  inconclusive: "decisions.criteria.inconclusive",
};

const STATUS_LABELS: Record<ExperimentStatus, UiTextKey> = {
  proposed: "decisions.status.proposed",
  approved: "decisions.status.approved",
  running: "decisions.status.running",
  concluded: "decisions.status.concluded",
  abandoned: "decisions.status.abandoned",
};
const TRANSITION_LABELS: Record<ExperimentStatus, UiTextKey> = {
  proposed: "decisions.transition.proposed",
  approved: "decisions.transition.approved",
  running: "decisions.transition.running",
  concluded: "decisions.transition.concluded",
  abandoned: "decisions.transition.abandoned",
};

// Phase 10 slice 1 (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md) -- manual-entry record-keeping
// for hypotheses -> experiments -> outcomes. No AI-generated hypotheses, no automatic execution
// (FUTURE_PHASES.md §6's own non-goals for this slice).
// `channel` is the dashboard's own currently-active owned channel (nullable -- e.g. no channel
// connected yet). Optional here because a hypothesis can be scoped to it (owner spec §6 case (A),
// "optimizing existing channels") or left channel-less (case (B), "new channel concept") -- the
// toggle below lets an operator pick per hypothesis, matching this app's standing rule that any
// boolean ON/OFF control uses the shared ToggleSwitch, never a native checkbox.
export function DecisionsManager({ channel }: { channel: ChannelInfo | null }) {
  const t = useT();
  const op = useOperation();
  const { runBlocking } = op;
  const [hypotheses, setHypotheses] = useState<Hypothesis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newStatement, setNewStatement] = useState("");
  const [newEvidenceNotes, setNewEvidenceNotes] = useState("");
  const [scopeToChannel, setScopeToChannel] = useState(false);
  const [creatingHypothesis, setCreatingHypothesis] = useState(false);

  // Phase 10 slice 4 -- AI-generated hypothesis drafts. Notes-only for this first UI pass
  // (evidence-linked generation is fully supported at the API/service layer and already tested
  // there; attaching real evidence to a saved hypothesis stays a separate, already-existing step
  // via the evidence section below, not duplicated into this generation form).
  const [genNotes, setGenNotes] = useState("");
  const [genScopeToChannel, setGenScopeToChannel] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    statement: string;
    rationale: string;
    providerName: string;
    connectionId: string | null;
  } | null>(null);
  const [editedStatement, setEditedStatement] = useState("");
  const [savingDraft, setSavingDraft] = useState(false);

  const [selectedHypothesisId, setSelectedHypothesisId] = useState<string | null>(null);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [experimentsLoading, setExperimentsLoading] = useState(false);

  const [newTreatment, setNewTreatment] = useState("");
  const [newControlBaseline, setNewControlBaseline] = useState("");
  const [newSuccessCriteria, setNewSuccessCriteria] = useState("");
  const [newStoppingCriteria, setNewStoppingCriteria] = useState("");
  const [newResponsible, setNewResponsible] = useState("");
  const [creatingExperiment, setCreatingExperiment] = useState(false);

  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<ExperimentOutcome[]>([]);
  const [outcomesLoading, setOutcomesLoading] = useState(false);

  const [outcomeData, setOutcomeData] = useState("");
  const [criteriaMet, setCriteriaMet] = useState<"met" | "not_met" | "inconclusive">("inconclusive");
  const [lessonsLearned, setLessonsLearned] = useState("");
  const [recordingOutcome, setRecordingOutcome] = useState(false);

  const [abandonTarget, setAbandonTarget] = useState<Experiment | null>(null);
  const [transitioning, setTransitioning] = useState(false);

  // Phase 10 slice 5 (docs/roadmap/plans/PHASE_10_SLICE_5_PLAN.md §6) -- attach/detach a Change
  // Set, then execute it (creates a real, dry-run-by-default Batch through the existing pipeline).
  const [changeSetIdInput, setChangeSetIdInput] = useState<Record<string, string>>({});
  const [settingChangeSet, setSettingChangeSet] = useState(false);
  const [executeTarget, setExecuteTarget] = useState<Experiment | null>(null);
  const [executeAsLive, setExecuteAsLive] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [executeResult, setExecuteResult] = useState<{ experimentId: string; batchId: string; videoCount: number; dryRun: boolean } | null>(
    null
  );

  // Phase 10 slice 3 (docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md §8) -- structured evidence,
  // additive alongside the free-text evidenceNotes shown above. No picker UI (a real channel/
  // video/snapshot browser is out of scope for this slice) -- the operator types the real
  // identifying id/date themselves; the server validates it actually exists before storing it.
  const [evidence, setEvidence] = useState<HypothesisEvidence[]>([]);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [evidenceSourceType, setEvidenceSourceType] = useState<EvidenceSourceType>("phase9_trend_candidate");
  const [evidenceChannelId, setEvidenceChannelId] = useState("");
  const [evidenceVideoId, setEvidenceVideoId] = useState("");
  const [evidenceMetricDate, setEvidenceMetricDate] = useState("");
  const [evidenceMetricName, setEvidenceMetricName] = useState("");
  const [evidenceResearchChannelId, setEvidenceResearchChannelId] = useState("");
  const [evidenceSnapshotId, setEvidenceSnapshotId] = useState("");
  const [evidenceTrendCandidateId, setEvidenceTrendCandidateId] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [addingEvidence, setAddingEvidence] = useState(false);

  const fetchHypotheses = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/decision-engine/hypotheses");
      if (res.ok) {
        const data = await res.json();
        setHypotheses(data.hypotheses ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchHypotheses();
  }, [fetchHypotheses]);

  const fetchExperiments = useCallback(async (hypothesisId: string) => {
    setExperimentsLoading(true);
    try {
      const res = await fetch(`/api/decision-engine/hypotheses/${encodeURIComponent(hypothesisId)}/experiments`);
      if (res.ok) {
        const data = await res.json();
        setExperiments(data.experiments ?? []);
      }
    } finally {
      setExperimentsLoading(false);
    }
  }, []);

  const fetchOutcomes = useCallback(async (experimentId: string) => {
    setOutcomesLoading(true);
    try {
      const res = await fetch(`/api/decision-engine/experiments/${encodeURIComponent(experimentId)}/outcomes`);
      if (res.ok) {
        const data = await res.json();
        setOutcomes(data.outcomes ?? []);
      }
    } finally {
      setOutcomesLoading(false);
    }
  }, []);

  const fetchEvidence = useCallback(async (hypothesisId: string) => {
    setEvidenceLoading(true);
    try {
      const res = await fetch(`/api/decision-engine/hypotheses/${encodeURIComponent(hypothesisId)}/evidence`);
      if (res.ok) {
        const data = await res.json();
        setEvidence(data.evidence ?? []);
      }
    } finally {
      setEvidenceLoading(false);
    }
  }, []);

  function handleSelectHypothesis(hypothesisId: string) {
    if (selectedHypothesisId === hypothesisId) {
      // Clicking the open row collapses it again.
      setSelectedHypothesisId(null);
      setSelectedExperimentId(null);
      setOutcomes([]);
      return;
    }
    setSelectedHypothesisId(hypothesisId);
    setSelectedExperimentId(null);
    setOutcomes([]);
    void fetchExperiments(hypothesisId);
    void fetchEvidence(hypothesisId);
  }

  function handleSelectExperiment(experimentId: string) {
    if (selectedExperimentId === experimentId) {
      setSelectedExperimentId(null);
      setOutcomes([]);
      return;
    }
    setSelectedExperimentId(experimentId);
    void fetchOutcomes(experimentId);
  }

  async function handleCreateHypothesis() {
    if (!newStatement || !newEvidenceNotes) {
      setError(t("decisions.error.statementRequired"));
      return;
    }
    setCreatingHypothesis(true);
    setError(null);
    try {
      const res = await fetch("/api/decision-engine/hypotheses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          statement: newStatement,
          evidenceNotes: newEvidenceNotes,
          channelId: scopeToChannel && channel ? channel.id : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("decisions.error.createHypothesis"), { showErrorField: false }));
        return;
      }
      setNewStatement("");
      setNewEvidenceNotes("");
      setScopeToChannel(false);
      await fetchHypotheses();
    } finally {
      setCreatingHypothesis(false);
    }
  }

  async function handleGenerateDraft() {
    if (!genNotes) {
      setGenError(t("decisions.error.notesRequired"));
      return;
    }
    setGenerating(true);
    setGenError(null);
    setDraft(null);
    try {
      const { res, data } = await runBlocking({
        title: t("decisions.generate.opTitle"),
        stage: t("decisions.generate.opStage"),
        request: async () => {
          const res = await fetch("/api/decision-engine/hypotheses/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              notes: genNotes,
              evidenceReferences: [],
              channelId: genScopeToChannel && channel ? channel.id : undefined,
            }),
          });
          return { res, data: await res.json() };
        },
        failureOf: ({ res, data }) => (res.ok ? null : (errorText(t, data, t("decisions.error.generate"), { showErrorField: false }))),
        summarize: () => t("decisions.generate.ready"),
      });
      if (!res.ok) {
        setGenError(errorText(t, data, t("decisions.error.generate"), { showErrorField: false }));
        return;
      }
      setDraft(data.draft);
      setEditedStatement(data.draft.statement);
    } finally {
      setGenerating(false);
    }
  }

  async function handleSaveDraft() {
    if (!draft || !editedStatement) return;
    setSavingDraft(true);
    setGenError(null);
    try {
      const res = await fetch("/api/decision-engine/hypotheses/generate/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          finalStatement: editedStatement,
          evidenceNotes: draft.rationale,
          evidenceReferences: [],
          generatedStatement: draft.statement,
          rationale: draft.rationale,
          providerName: draft.providerName,
          connectionId: draft.connectionId ?? undefined,
          channelId: genScopeToChannel && channel ? channel.id : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setGenError(errorText(t, data, t("decisions.error.saveGenerated"), { showErrorField: false }));
        return;
      }
      setDraft(null);
      setEditedStatement("");
      setGenNotes("");
      setGenScopeToChannel(false);
      await fetchHypotheses();
    } finally {
      setSavingDraft(false);
    }
  }

  async function handleCreateExperiment() {
    if (!selectedHypothesisId) return;
    if (!newTreatment || !newControlBaseline || !newSuccessCriteria || !newStoppingCriteria || !newResponsible) {
      setError(t("decisions.error.experimentFieldsRequired"));
      return;
    }
    setCreatingExperiment(true);
    setError(null);
    try {
      const res = await fetch(`/api/decision-engine/hypotheses/${encodeURIComponent(selectedHypothesisId)}/experiments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          treatment: newTreatment,
          controlBaseline: newControlBaseline,
          successCriteria: newSuccessCriteria,
          stoppingCriteria: newStoppingCriteria,
          responsible: newResponsible,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("decisions.error.createExperiment"), { showErrorField: false }));
        return;
      }
      setNewTreatment("");
      setNewControlBaseline("");
      setNewSuccessCriteria("");
      setNewStoppingCriteria("");
      setNewResponsible("");
      await fetchExperiments(selectedHypothesisId);
    } finally {
      setCreatingExperiment(false);
    }
  }

  function buildEvidenceReference(): Record<string, string> | null {
    switch (evidenceSourceType) {
      case "phase8_metric":
        if (!evidenceChannelId || !evidenceVideoId || !evidenceMetricDate || !evidenceMetricName) return null;
        return {
          sourceType: "phase8_metric",
          channelId: evidenceChannelId,
          videoId: evidenceVideoId,
          metricDate: evidenceMetricDate,
          metricName: evidenceMetricName,
        };
      case "phase9_channel_snapshot":
      case "phase9_video_snapshot":
        if (!evidenceResearchChannelId || !evidenceSnapshotId) return null;
        return { sourceType: evidenceSourceType, researchChannelId: evidenceResearchChannelId, snapshotId: evidenceSnapshotId };
      case "phase9_trend_candidate":
        if (!evidenceTrendCandidateId) return null;
        return { sourceType: "phase9_trend_candidate", trendCandidateId: evidenceTrendCandidateId };
    }
  }

  async function handleAddEvidence() {
    if (!selectedHypothesisId) return;
    const reference = buildEvidenceReference();
    if (!reference) {
      setEvidenceError(t("decisions.error.evidenceFieldsRequired"));
      return;
    }
    setAddingEvidence(true);
    setEvidenceError(null);
    try {
      const res = await fetch(`/api/decision-engine/hypotheses/${encodeURIComponent(selectedHypothesisId)}/evidence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reference, ...(evidenceNote ? { note: evidenceNote } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setEvidenceError(errorText(t, data, t("decisions.error.addEvidence"), { showErrorField: false }));
        return;
      }
      setEvidenceChannelId("");
      setEvidenceVideoId("");
      setEvidenceMetricDate("");
      setEvidenceMetricName("");
      setEvidenceResearchChannelId("");
      setEvidenceSnapshotId("");
      setEvidenceTrendCandidateId("");
      setEvidenceNote("");
      await fetchEvidence(selectedHypothesisId);
    } finally {
      setAddingEvidence(false);
    }
  }

  async function transition(experiment: Experiment, targetStatus: ExperimentStatus) {
    setTransitioning(true);
    setError(null);
    try {
      const res = await fetch(`/api/decision-engine/experiments/${encodeURIComponent(experiment.experimentId)}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetStatus }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("decisions.error.transition"), { showErrorField: false }));
        return;
      }
      if (selectedHypothesisId) await fetchExperiments(selectedHypothesisId);
    } finally {
      setTransitioning(false);
    }
  }

  async function handleConfirmAbandon() {
    if (!abandonTarget) return;
    await transition(abandonTarget, "abandoned");
    setAbandonTarget(null);
  }

  async function handleSetChangeSet(experiment: Experiment, changeSetId: string | null) {
    setSettingChangeSet(true);
    setError(null);
    try {
      const res = await fetch(`/api/decision-engine/experiments/${encodeURIComponent(experiment.experimentId)}/change-set`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changeSetId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("decisions.error.changeSet"), { showErrorField: false }));
        return;
      }
      if (selectedHypothesisId) await fetchExperiments(selectedHypothesisId);
    } finally {
      setSettingChangeSet(false);
    }
  }

  async function handleConfirmExecute() {
    if (!executeTarget) return;
    setExecuting(true);
    setError(null);
    try {
      const res = await fetch(`/api/decision-engine/experiments/${encodeURIComponent(executeTarget.experimentId)}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ live: executeAsLive }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("decisions.error.execute"), { showErrorField: false }));
        return;
      }
      setExecuteResult({ experimentId: executeTarget.experimentId, batchId: data.batchId, videoCount: data.videoCount, dryRun: data.dryRun });
      if (selectedHypothesisId) await fetchExperiments(selectedHypothesisId);
    } finally {
      setExecuting(false);
      setExecuteTarget(null);
      setExecuteAsLive(false);
    }
  }

  async function handleRecordOutcome() {
    if (!selectedExperimentId || !outcomeData) {
      setError(t("decisions.error.outcomeRequired"));
      return;
    }
    setRecordingOutcome(true);
    setError(null);
    try {
      const res = await fetch(`/api/decision-engine/experiments/${encodeURIComponent(selectedExperimentId)}/outcomes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcomeData, criteriaMet, lessonsLearned: lessonsLearned || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(errorText(t, data, t("decisions.error.recordOutcome"), { showErrorField: false }));
        return;
      }
      setOutcomeData("");
      setLessonsLearned("");
      setCriteriaMet("inconclusive");
      await fetchOutcomes(selectedExperimentId);
    } finally {
      setRecordingOutcome(false);
    }
  }

  const selectedExperiment = experiments.find((e) => e.experimentId === selectedExperimentId) ?? null;

  return (
    <div className="space-y-6">
      <OperationOverlay state={op.state} onClose={op.reset} />
      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
        <h3 className="mb-3 font-medium">{t("decisions.newHypothesis")}</h3>
        <div className="space-y-2">
          <textarea
            className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
            placeholder={t("decisions.placeholder.statement")}
            value={newStatement}
            onChange={(e) => setNewStatement(e.target.value)}
          />
          <textarea
            className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
            placeholder={t("decisions.placeholder.evidenceNotes")}
            value={newEvidenceNotes}
            onChange={(e) => setNewEvidenceNotes(e.target.value)}
          />
          {channel && (
            <div className="flex items-center gap-2">
              <ToggleSwitch
                checked={scopeToChannel}
                onChange={setScopeToChannel}
                label={t("decisions.scopeTo", { channel: channel.title })}
              />
              <span className="text-sm text-zinc-400">
                {scopeToChannel ? t("decisions.scopedTo", { channel: channel.title }) : t("decisions.newChannelConceptLong")}
              </span>
            </div>
          )}
          <button
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            disabled={creatingHypothesis}
            onClick={() => void handleCreateHypothesis()}
          >
            {creatingHypothesis ? t("decisions.creating") : t("decisions.createHypothesis")}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
        <h3 className="mb-3 font-medium">{t("decisions.generate.title")}</h3>
        <p className="mb-3 text-sm text-zinc-400">{t("decisions.generate.intro")}</p>
        {genError && <p className="mb-2 text-sm text-red-400">{genError}</p>}
        <div className="space-y-2">
          <textarea
            className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
            placeholder={t("decisions.placeholder.genNotes")}
            value={genNotes}
            onChange={(e) => setGenNotes(e.target.value)}
          />
          {channel && (
            <div className="flex items-center gap-2">
              <ToggleSwitch checked={genScopeToChannel} onChange={setGenScopeToChannel} label={t("decisions.scopeTo", { channel: channel.title })} />
              <span className="text-sm text-zinc-400">
                {genScopeToChannel ? t("decisions.scopedTo", { channel: channel.title }) : t("decisions.newChannelConceptLong")}
              </span>
            </div>
          )}
          <button
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            disabled={generating}
            onClick={() => void handleGenerateDraft()}
          >
            {generating ? t("decisions.generate.generating") : t("decisions.generate.button")}
          </button>
          {draft && (
            <div className="mt-3 space-y-2 rounded border border-zinc-700 bg-zinc-800 p-3">
              <p className="text-xs text-zinc-500">{t("decisions.generate.provider", { provider: draft.providerName })}</p>
              <textarea
                className="w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-sm"
                value={editedStatement}
                onChange={(e) => setEditedStatement(e.target.value)}
              />
              <p className="text-xs text-zinc-400">{t("decisions.generate.rationale", { rationale: draft.rationale })}</p>
              <button
                className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                disabled={savingDraft}
                onClick={() => void handleSaveDraft()}
              >
                {savingDraft ? t("common.saving") : t("decisions.generate.save")}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
        <h3 className="mb-3 font-medium">{t("decisions.hypotheses")}</h3>
        {loading ? (
          <LoadingIndicator className="text-sm text-zinc-400" />
        ) : hypotheses.length === 0 ? (
          <p className="text-sm text-zinc-400">{t("decisions.noHypotheses")}</p>
        ) : (
          <ul className="space-y-2">
            {hypotheses.map((h) => (
              <li key={h.hypothesisId}>
                <button
                  className={`w-full rounded border p-2 text-left text-sm ${
                    selectedHypothesisId === h.hypothesisId ? "border-indigo-500 bg-zinc-800" : "border-zinc-700"
                  }`}
                  onClick={() => handleSelectHypothesis(h.hypothesisId)}
                >
                  <div className="font-medium">{h.statement}</div>
                  <div className="text-xs text-zinc-400">
                    {formatDisplayDateTime(h.createdAt)}
                    {" · "}
                    {h.channelId
                      ? t("decisions.scopedToShort", { channel: (h.channelId === channel?.id ? channel?.title : h.channelId) ?? h.channelId })
                      : t("decisions.newChannelConcept")}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selectedHypothesisId && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
          <h3 className="mb-3 font-medium">{t("decisions.newExperiment")}</h3>
          <div className="space-y-2">
            <input
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              placeholder={t("decisions.placeholder.treatment")}
              value={newTreatment}
              onChange={(e) => setNewTreatment(e.target.value)}
            />
            <input
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              placeholder={t("decisions.placeholder.controlBaseline")}
              value={newControlBaseline}
              onChange={(e) => setNewControlBaseline(e.target.value)}
            />
            <input
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              placeholder={t("decisions.placeholder.successCriteria")}
              value={newSuccessCriteria}
              onChange={(e) => setNewSuccessCriteria(e.target.value)}
            />
            <input
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              placeholder={t("decisions.placeholder.stoppingCriteria")}
              value={newStoppingCriteria}
              onChange={(e) => setNewStoppingCriteria(e.target.value)}
            />
            <input
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              placeholder={t("decisions.placeholder.responsible")}
              value={newResponsible}
              onChange={(e) => setNewResponsible(e.target.value)}
            />
            <button
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              disabled={creatingExperiment}
              onClick={() => void handleCreateExperiment()}
            >
              {creatingExperiment ? t("decisions.creating") : t("decisions.createExperiment")}
            </button>
          </div>

          <h4 className="mt-4 mb-2 font-medium">{t("decisions.experiments")}</h4>
          {experimentsLoading ? (
            <LoadingIndicator className="text-sm text-zinc-400" />
          ) : experiments.length === 0 ? (
            <p className="text-sm text-zinc-400">{t("decisions.noExperiments")}</p>
          ) : (
            <ul className="space-y-2">
              {experiments.map((exp) => {
                const hypothesisChannelId = hypotheses.find((h) => h.hypothesisId === exp.hypothesisId)?.channelId ?? null;
                // Phase 10 slice 5 -- once a Change Set is attached, "running" is reached only
                // through Execute, never the generic transition button (the server itself
                // enforces this with EXPERIMENT_MUST_USE_EXECUTE; hidden here too so there is no
                // button that always fails once attached).
                const nextStatuses = NEXT_STATUSES[exp.status].filter((target) => !(target === "running" && exp.changeSetId));
                const canEditChangeSet = exp.status === "proposed" || exp.status === "approved";
                return (
                  <li key={exp.experimentId} className="rounded border border-zinc-700 p-2">
                    <button className="w-full text-left text-sm" onClick={() => handleSelectExperiment(exp.experimentId)}>
                      <div className="font-medium">{exp.treatment}</div>
                      <div className="text-xs text-zinc-400">
                        {t(STATUS_LABELS[exp.status])}
                        {exp.approvedBy ? ` · ${t("decisions.approvedBy", { name: exp.approvedBy })}` : ""}
                        {exp.executionBatchId ? ` · ${t("decisions.batchRef", { batchId: exp.executionBatchId })}` : ""}
                      </div>
                    </button>
                    <div className="mt-2 flex gap-2">
                      {nextStatuses.map((target) =>
                        target === "abandoned" ? (
                          <button
                            key={target}
                            className="rounded border border-zinc-600 px-2 py-1 text-xs disabled:opacity-50"
                            disabled={transitioning}
                            onClick={() => setAbandonTarget(exp)}
                          >
                            {t("decisions.abandon")}
                          </button>
                        ) : (
                          <button
                            key={target}
                            className="rounded border border-zinc-600 px-2 py-1 text-xs disabled:opacity-50"
                            disabled={transitioning}
                            onClick={() => void transition(exp, target)}
                          >
                            {t(TRANSITION_LABELS[target])}
                          </button>
                        )
                      )}
                      {exp.status === "approved" && exp.changeSetId && (
                        <button
                          className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium disabled:opacity-50"
                          disabled={executing}
                          onClick={() => setExecuteTarget(exp)}
                        >
                          {t("decisions.execute")}
                        </button>
                      )}
                    </div>
                    {hypothesisChannelId && canEditChangeSet && (
                      <div className="mt-2 flex items-center gap-2 text-xs">
                        {exp.changeSetId ? (
                          <>
                            <span className="text-zinc-400">{t("decisions.changeSetRef", { changeSetId: exp.changeSetId })}</span>
                            <button
                              className="rounded border border-zinc-600 px-2 py-0.5 disabled:opacity-50"
                              disabled={settingChangeSet}
                              onClick={() => void handleSetChangeSet(exp, null)}
                            >
                              {t("decisions.detach")}
                            </button>
                          </>
                        ) : (
                          <>
                            <input
                              className="w-40 rounded border border-zinc-700 bg-zinc-800 p-1"
                              placeholder={t("decisions.placeholder.changeSetId")}
                              value={changeSetIdInput[exp.experimentId] ?? ""}
                              onChange={(e) => setChangeSetIdInput((prev) => ({ ...prev, [exp.experimentId]: e.target.value }))}
                            />
                            <button
                              className="rounded border border-zinc-600 px-2 py-0.5 disabled:opacity-50"
                              disabled={settingChangeSet || !(changeSetIdInput[exp.experimentId] ?? "").trim()}
                              onClick={() => void handleSetChangeSet(exp, (changeSetIdInput[exp.experimentId] ?? "").trim())}
                            >
                              {t("decisions.attach")}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    {executeResult && executeResult.experimentId === exp.experimentId && (
                      <p className={`mt-2 text-xs ${executeResult.dryRun ? "text-emerald-400" : "text-red-400"}`}>
                        {t(executeResult.dryRun ? "decisions.executeResultDryRun" : "decisions.executeResultLive", {
                          batchId: executeResult.batchId,
                          count: executeResult.videoCount,
                        })}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {selectedHypothesisId && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
          <h3 className="mb-1 font-medium">{t("decisions.evidence.title")}</h3>
          <p className="mb-3 text-xs text-zinc-400">{t("decisions.evidence.intro")}</p>
          <div className="mb-4 space-y-2">
            <select
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              value={evidenceSourceType}
              onChange={(e) => setEvidenceSourceType(e.target.value as EvidenceSourceType)}
            >
              {Object.entries(EVIDENCE_SOURCE_TYPE_LABELS).map(([value, labelKey]) => (
                <option key={value} value={value}>
                  {t(labelKey)}
                </option>
              ))}
            </select>
            {evidenceSourceType === "phase8_metric" && (
              <>
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                  placeholder={t("decisions.placeholder.channelId")}
                  value={evidenceChannelId}
                  onChange={(e) => setEvidenceChannelId(e.target.value)}
                />
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                  placeholder={t("decisions.placeholder.videoId")}
                  value={evidenceVideoId}
                  onChange={(e) => setEvidenceVideoId(e.target.value)}
                />
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                  placeholder={t("decisions.placeholder.metricDate")}
                  value={evidenceMetricDate}
                  onChange={(e) => setEvidenceMetricDate(e.target.value)}
                />
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                  placeholder={t("decisions.placeholder.metricName")}
                  value={evidenceMetricName}
                  onChange={(e) => setEvidenceMetricName(e.target.value)}
                />
              </>
            )}
            {(evidenceSourceType === "phase9_channel_snapshot" || evidenceSourceType === "phase9_video_snapshot") && (
              <>
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                  placeholder={t("decisions.placeholder.researchChannelId")}
                  value={evidenceResearchChannelId}
                  onChange={(e) => setEvidenceResearchChannelId(e.target.value)}
                />
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                  placeholder={t("decisions.placeholder.snapshotId")}
                  value={evidenceSnapshotId}
                  onChange={(e) => setEvidenceSnapshotId(e.target.value)}
                />
              </>
            )}
            {evidenceSourceType === "phase9_trend_candidate" && (
              <input
                className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                placeholder={t("decisions.placeholder.trendCandidateId")}
                value={evidenceTrendCandidateId}
                onChange={(e) => setEvidenceTrendCandidateId(e.target.value)}
              />
            )}
            <input
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              placeholder={t("decisions.placeholder.note")}
              value={evidenceNote}
              onChange={(e) => setEvidenceNote(e.target.value)}
            />
            {evidenceError && <p className="text-sm text-red-400">{evidenceError}</p>}
            <button
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              disabled={addingEvidence}
              onClick={() => void handleAddEvidence()}
            >
              {addingEvidence ? t("decisions.evidence.adding") : t("decisions.evidence.add")}
            </button>
          </div>

          {evidenceLoading ? (
            <LoadingIndicator className="text-sm text-zinc-400" />
          ) : evidence.length === 0 ? (
            <p className="text-sm text-zinc-400">{t("decisions.evidence.none")}</p>
          ) : (
            <ul className="space-y-2">
              {evidence.map((item) => (
                <li key={item.evidenceId} className="rounded border border-zinc-700 p-2 text-sm">
                  <div className="font-medium">{t(EVIDENCE_SOURCE_TYPE_LABELS[item.reference.sourceType])}</div>
                  <div className="text-xs text-zinc-400">
                    {Object.entries(item.reference)
                      .filter(([key]) => key !== "sourceType")
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(" · ")}
                  </div>
                  {item.note && <div className="mt-1 text-xs text-zinc-300">{item.note}</div>}
                  <div className="mt-1 text-xs text-zinc-500">{formatDisplayDateTime(item.createdAt)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {selectedExperiment && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
          <h3 className="mb-1 font-medium">{t("decisions.outcomes.title", { treatment: selectedExperiment.treatment })}</h3>
          <dl className="mb-3 space-y-1 text-xs text-zinc-400">
            <div>
              <dt className="inline font-medium text-zinc-300">{t("decisions.outcomes.controlBaseline")} </dt>
              <dd className="inline">{selectedExperiment.controlBaseline}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-zinc-300">{t("decisions.outcomes.successCriteria")} </dt>
              <dd className="inline">{selectedExperiment.successCriteria}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-zinc-300">{t("decisions.outcomes.stoppingCriteria")} </dt>
              <dd className="inline">{selectedExperiment.stoppingCriteria}</dd>
            </div>
            {selectedHypothesisId && (
              <div>
                <dt className="inline font-medium text-zinc-300">{t("decisions.outcomes.hypothesisEvidence")} </dt>
                <dd className="inline">{hypotheses.find((h) => h.hypothesisId === selectedHypothesisId)?.evidenceNotes}</dd>
              </div>
            )}
          </dl>

          <ExperimentArmsPanel
            experimentId={selectedExperiment.experimentId}
            status={selectedExperiment.status}
            hypothesisChannelId={hypotheses.find((h) => h.hypothesisId === selectedExperiment.hypothesisId)?.channelId ?? null}
            activeChannelId={channel?.id ?? null}
          />

          {OUTCOME_RECORDABLE_STATUSES.includes(selectedExperiment.status) ? (
            <div className="mb-4 space-y-2">
              <textarea
                className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                placeholder={t("decisions.placeholder.outcomeData")}
                value={outcomeData}
                onChange={(e) => setOutcomeData(e.target.value)}
              />
              <select
                className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                value={criteriaMet}
                onChange={(e) => setCriteriaMet(e.target.value as "met" | "not_met" | "inconclusive")}
              >
                <option value="met">{t("decisions.criteria.met")}</option>
                <option value="not_met">{t("decisions.criteria.notMet")}</option>
                <option value="inconclusive">{t("decisions.criteria.inconclusive")}</option>
              </select>
              <textarea
                className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                placeholder={t("decisions.placeholder.lessons")}
                value={lessonsLearned}
                onChange={(e) => setLessonsLearned(e.target.value)}
              />
              <button
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                disabled={recordingOutcome}
                onClick={() => void handleRecordOutcome()}
              >
                {recordingOutcome ? t("decisions.outcomes.recording") : t("decisions.outcomes.record")}
              </button>
            </div>
          ) : (
            <p className="mb-4 text-sm text-zinc-400">{t("decisions.outcomes.notYet")}</p>
          )}

          {outcomesLoading ? (
            <LoadingIndicator className="text-sm text-zinc-400" />
          ) : outcomes.length === 0 ? (
            <p className="text-sm text-zinc-400">{t("decisions.outcomes.none")}</p>
          ) : (
            <ul className="space-y-2">
              {outcomes.map((o) => (
                <li key={o.outcomeId} className="rounded border border-zinc-700 p-2 text-sm">
                  <div>{o.outcomeData}</div>
                  <div className="text-xs text-zinc-400">
                    {CRITERIA_LABELS[o.criteriaMet] ? t(CRITERIA_LABELS[o.criteriaMet]) : o.criteriaMet} · {formatDisplayDateTime(o.recordedAt)} · {o.recordedBy}
                  </div>
                  {o.lessonsLearned && <div className="mt-1 text-xs italic text-zinc-400">{o.lessonsLearned}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {abandonTarget && (
        <ConfirmDialog
          title={t("decisions.abandonConfirm.title")}
          description={t("decisions.abandonConfirm.body", { treatment: abandonTarget.treatment })}
          confirmLabel={t("decisions.abandon")}
          confirmVariant="danger"
          onCancel={() => setAbandonTarget(null)}
          onConfirm={() => void handleConfirmAbandon()}
        />
      )}

      {executeTarget && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={() => setExecuteTarget(null)}>
          <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 font-medium">{t("decisions.executeDialog.title")}</h3>
            <p className="mb-3 text-sm text-zinc-400">{t("decisions.executeDialog.body", { changeSetId: executeTarget.changeSetId ?? "" })}</p>
            <div className="mb-4 flex items-center gap-2">
              <ToggleSwitch checked={executeAsLive} onChange={setExecuteAsLive} label={t("decisions.executeDialog.liveToggle")} />
              <span className="text-sm">{t("decisions.executeDialog.liveToggleHint")}</span>
            </div>
            <div className="flex justify-end gap-2">
              <button className="rounded border border-zinc-600 px-3 py-1.5 text-sm" onClick={() => setExecuteTarget(null)}>
                {t("common.cancel")}
              </button>
              <button
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                disabled={executing}
                onClick={() => void handleConfirmExecute()}
              >
                {executing ? t("decisions.executing") : t("decisions.execute")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
