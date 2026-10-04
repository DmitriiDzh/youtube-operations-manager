"use client";

import { useCallback, useEffect, useState } from "react";
import { OperationOverlay, useOperation, LoadingIndicator } from "./operation-progress";
import { ConfirmDialog } from "./confirm-dialog";
import { ToggleSwitch } from "./toggle-switch";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import {
  EXPERIMENT_STATUS_TRANSITIONS as NEXT_STATUSES,
  EXPERIMENT_OUTCOME_RECORDABLE_STATUSES as OUTCOME_RECORDABLE_STATUSES,
  EXPERIMENT_STATUS_LABELS as STATUS_LABELS,
  type ExperimentStatus,
} from "@/lib/decision-engine/status";
import type { ChannelInfo } from "@/app/dashboard/page";

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

const EVIDENCE_SOURCE_TYPE_LABELS: Record<EvidenceSourceType, string> = {
  phase8_metric: "Phase 8 metric (our own channel)",
  phase9_channel_snapshot: "Phase 9 channel snapshot",
  phase9_video_snapshot: "Phase 9 video snapshot",
  phase9_trend_candidate: "Phase 9 trend candidate",
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
      setError("Statement and evidence notes are required");
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
        setError(data.message ?? "Failed to create hypothesis");
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
      setGenError("Notes are required");
      return;
    }
    setGenerating(true);
    setGenError(null);
    setDraft(null);
    try {
      const { res, data } = await runBlocking({
        title: "Generating a hypothesis draft",
        stage: "Waiting for the AI provider",
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
        failureOf: ({ res, data }) => (res.ok ? null : (data.message ?? "Failed to generate a draft")),
        summarize: () => "Draft ready for review.",
      });
      if (!res.ok) {
        setGenError(data.message ?? "Failed to generate a draft");
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
        setGenError(data.message ?? "Failed to save the generated hypothesis");
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
      setError("Treatment, control/baseline, success criteria, stopping criteria, and responsible are all required");
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
        setError(data.message ?? "Failed to create experiment");
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
      setEvidenceError("All identifying fields for the selected source type are required");
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
        setEvidenceError(data.message ?? "Failed to add evidence");
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
        setError(data.message ?? "Failed to transition experiment");
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
        setError(data.message ?? "Failed to update the experiment's Change Set");
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
        setError(data.message ?? "Failed to execute experiment");
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
      setError("Outcome data is required");
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
        setError(data.message ?? "Failed to record outcome");
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
        <h3 className="mb-3 font-medium">New hypothesis</h3>
        <div className="space-y-2">
          <textarea
            className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
            placeholder="Statement -- a falsifiable proposition (e.g. shorter titles improve CTR)"
            value={newStatement}
            onChange={(e) => setNewStatement(e.target.value)}
          />
          <textarea
            className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
            placeholder="Evidence notes -- why do we think this?"
            value={newEvidenceNotes}
            onChange={(e) => setNewEvidenceNotes(e.target.value)}
          />
          {channel && (
            <div className="flex items-center gap-2">
              <ToggleSwitch
                checked={scopeToChannel}
                onChange={setScopeToChannel}
                label={`Scope to ${channel.title}`}
              />
              <span className="text-sm text-zinc-400">
                {scopeToChannel ? `Scoped to ${channel.title}` : "New channel concept (not scoped to any owned channel)"}
              </span>
            </div>
          )}
          <button
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            disabled={creatingHypothesis}
            onClick={() => void handleCreateHypothesis()}
          >
            {creatingHypothesis ? "Creating..." : "Create hypothesis"}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
        <h3 className="mb-3 font-medium">Generate with AI</h3>
        <p className="mb-3 text-sm text-zinc-400">
          A draft is always generated by the mock provider unless a real AI Connection is configured in Settings -- it
          is never saved automatically. Review and edit it below before saving.
        </p>
        {genError && <p className="mb-2 text-sm text-red-400">{genError}</p>}
        <div className="space-y-2">
          <textarea
            className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
            placeholder="Notes -- what should the AI draft a hypothesis about?"
            value={genNotes}
            onChange={(e) => setGenNotes(e.target.value)}
          />
          {channel && (
            <ToggleSwitch checked={genScopeToChannel} onChange={setGenScopeToChannel} label={`Scope to ${channel.title}`} />
          )}
          <button
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            disabled={generating}
            onClick={() => void handleGenerateDraft()}
          >
            {generating ? "Generating..." : "Generate draft"}
          </button>
          {draft && (
            <div className="mt-3 space-y-2 rounded border border-zinc-700 bg-zinc-800 p-3">
              <p className="text-xs text-zinc-500">Provider: {draft.providerName}</p>
              <textarea
                className="w-full rounded border border-zinc-700 bg-zinc-900 p-2 text-sm"
                value={editedStatement}
                onChange={(e) => setEditedStatement(e.target.value)}
              />
              <p className="text-xs text-zinc-400">Rationale: {draft.rationale}</p>
              <button
                className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                disabled={savingDraft}
                onClick={() => void handleSaveDraft()}
              >
                {savingDraft ? "Saving..." : "Save as hypothesis"}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
        <h3 className="mb-3 font-medium">Hypotheses</h3>
        {loading ? (
          <LoadingIndicator className="text-sm text-zinc-400" />
        ) : hypotheses.length === 0 ? (
          <p className="text-sm text-zinc-400">No hypotheses yet.</p>
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
                    {h.channelId ? ` · scoped to ${h.channelId === channel?.id ? channel?.title : h.channelId}` : " · new channel concept"}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selectedHypothesisId && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
          <h3 className="mb-3 font-medium">New experiment</h3>
          <div className="space-y-2">
            <input
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              placeholder="Treatment"
              value={newTreatment}
              onChange={(e) => setNewTreatment(e.target.value)}
            />
            <input
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              placeholder="Control / baseline"
              value={newControlBaseline}
              onChange={(e) => setNewControlBaseline(e.target.value)}
            />
            <input
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              placeholder="Success criteria"
              value={newSuccessCriteria}
              onChange={(e) => setNewSuccessCriteria(e.target.value)}
            />
            <input
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              placeholder="Stopping criteria"
              value={newStoppingCriteria}
              onChange={(e) => setNewStoppingCriteria(e.target.value)}
            />
            <input
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              placeholder="Responsible (who owns this experiment)"
              value={newResponsible}
              onChange={(e) => setNewResponsible(e.target.value)}
            />
            <button
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              disabled={creatingExperiment}
              onClick={() => void handleCreateExperiment()}
            >
              {creatingExperiment ? "Creating..." : "Create experiment"}
            </button>
          </div>

          <h4 className="mt-4 mb-2 font-medium">Experiments</h4>
          {experimentsLoading ? (
            <LoadingIndicator className="text-sm text-zinc-400" />
          ) : experiments.length === 0 ? (
            <p className="text-sm text-zinc-400">No experiments yet.</p>
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
                        {STATUS_LABELS[exp.status]}
                        {exp.approvedBy ? ` · approved by ${exp.approvedBy}` : ""}
                        {exp.executionBatchId ? ` · Batch ${exp.executionBatchId}` : ""}
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
                            Abandon
                          </button>
                        ) : (
                          <button
                            key={target}
                            className="rounded border border-zinc-600 px-2 py-1 text-xs disabled:opacity-50"
                            disabled={transitioning}
                            onClick={() => void transition(exp, target)}
                          >
                            {STATUS_LABELS[target]}
                          </button>
                        )
                      )}
                      {exp.status === "approved" && exp.changeSetId && (
                        <button
                          className="rounded bg-indigo-600 px-2 py-1 text-xs font-medium disabled:opacity-50"
                          disabled={executing}
                          onClick={() => setExecuteTarget(exp)}
                        >
                          Execute
                        </button>
                      )}
                    </div>
                    {hypothesisChannelId && canEditChangeSet && (
                      <div className="mt-2 flex items-center gap-2 text-xs">
                        {exp.changeSetId ? (
                          <>
                            <span className="text-zinc-400">Change Set: {exp.changeSetId}</span>
                            <button
                              className="rounded border border-zinc-600 px-2 py-0.5 disabled:opacity-50"
                              disabled={settingChangeSet}
                              onClick={() => void handleSetChangeSet(exp, null)}
                            >
                              Detach
                            </button>
                          </>
                        ) : (
                          <>
                            <input
                              className="w-40 rounded border border-zinc-700 bg-zinc-800 p-1"
                              placeholder="Change Set id"
                              value={changeSetIdInput[exp.experimentId] ?? ""}
                              onChange={(e) => setChangeSetIdInput((prev) => ({ ...prev, [exp.experimentId]: e.target.value }))}
                            />
                            <button
                              className="rounded border border-zinc-600 px-2 py-0.5 disabled:opacity-50"
                              disabled={settingChangeSet || !(changeSetIdInput[exp.experimentId] ?? "").trim()}
                              onClick={() => void handleSetChangeSet(exp, (changeSetIdInput[exp.experimentId] ?? "").trim())}
                            >
                              Attach
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    {executeResult && executeResult.experimentId === exp.experimentId && (
                      <p className={`mt-2 text-xs ${executeResult.dryRun ? "text-emerald-400" : "text-red-400"}`}>
                        Created {executeResult.dryRun ? "dry-run" : "LIVE"} Batch {executeResult.batchId} ({executeResult.videoCount}{" "}
                        video(s)) -- open the Batches tab to review/run it.
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
          <h3 className="mb-1 font-medium">Structured evidence</h3>
          <p className="mb-3 text-xs text-zinc-400">
            A validated reference into real Phase 8/9 data, in addition to the free-text evidence above -- the server
            confirms the referenced row actually exists before it is stored.
          </p>
          <div className="mb-4 space-y-2">
            <select
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              value={evidenceSourceType}
              onChange={(e) => setEvidenceSourceType(e.target.value as EvidenceSourceType)}
            >
              {Object.entries(EVIDENCE_SOURCE_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {evidenceSourceType === "phase8_metric" && (
              <>
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                  placeholder="Channel id (our own owned channel)"
                  value={evidenceChannelId}
                  onChange={(e) => setEvidenceChannelId(e.target.value)}
                />
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                  placeholder="Video id"
                  value={evidenceVideoId}
                  onChange={(e) => setEvidenceVideoId(e.target.value)}
                />
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                  placeholder="Metric date (YYYY-MM-DD)"
                  value={evidenceMetricDate}
                  onChange={(e) => setEvidenceMetricDate(e.target.value)}
                />
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                  placeholder="Metric name"
                  value={evidenceMetricName}
                  onChange={(e) => setEvidenceMetricName(e.target.value)}
                />
              </>
            )}
            {(evidenceSourceType === "phase9_channel_snapshot" || evidenceSourceType === "phase9_video_snapshot") && (
              <>
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                  placeholder="Research channel id (UC...)"
                  value={evidenceResearchChannelId}
                  onChange={(e) => setEvidenceResearchChannelId(e.target.value)}
                />
                <input
                  className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                  placeholder="Snapshot id"
                  value={evidenceSnapshotId}
                  onChange={(e) => setEvidenceSnapshotId(e.target.value)}
                />
              </>
            )}
            {evidenceSourceType === "phase9_trend_candidate" && (
              <input
                className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                placeholder="Trend candidate id"
                value={evidenceTrendCandidateId}
                onChange={(e) => setEvidenceTrendCandidateId(e.target.value)}
              />
            )}
            <input
              className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
              placeholder="Note (optional)"
              value={evidenceNote}
              onChange={(e) => setEvidenceNote(e.target.value)}
            />
            {evidenceError && <p className="text-sm text-red-400">{evidenceError}</p>}
            <button
              className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              disabled={addingEvidence}
              onClick={() => void handleAddEvidence()}
            >
              {addingEvidence ? "Adding..." : "Add evidence"}
            </button>
          </div>

          {evidenceLoading ? (
            <LoadingIndicator className="text-sm text-zinc-400" />
          ) : evidence.length === 0 ? (
            <p className="text-sm text-zinc-400">No structured evidence yet.</p>
          ) : (
            <ul className="space-y-2">
              {evidence.map((item) => (
                <li key={item.evidenceId} className="rounded border border-zinc-700 p-2 text-sm">
                  <div className="font-medium">{EVIDENCE_SOURCE_TYPE_LABELS[item.reference.sourceType]}</div>
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
          <h3 className="mb-1 font-medium">Outcomes -- {selectedExperiment.treatment}</h3>
          <dl className="mb-3 space-y-1 text-xs text-zinc-400">
            <div>
              <dt className="inline font-medium text-zinc-300">Control/baseline: </dt>
              <dd className="inline">{selectedExperiment.controlBaseline}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-zinc-300">Success criteria: </dt>
              <dd className="inline">{selectedExperiment.successCriteria}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-zinc-300">Stopping criteria: </dt>
              <dd className="inline">{selectedExperiment.stoppingCriteria}</dd>
            </div>
            {selectedHypothesisId && (
              <div>
                <dt className="inline font-medium text-zinc-300">Hypothesis evidence: </dt>
                <dd className="inline">{hypotheses.find((h) => h.hypothesisId === selectedHypothesisId)?.evidenceNotes}</dd>
              </div>
            )}
          </dl>

          {OUTCOME_RECORDABLE_STATUSES.includes(selectedExperiment.status) ? (
            <div className="mb-4 space-y-2">
              <textarea
                className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                placeholder="Outcome data -- actual data / comparison against baseline"
                value={outcomeData}
                onChange={(e) => setOutcomeData(e.target.value)}
              />
              <select
                className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                value={criteriaMet}
                onChange={(e) => setCriteriaMet(e.target.value as "met" | "not_met" | "inconclusive")}
              >
                <option value="met">Success criteria met</option>
                <option value="not_met">Success criteria not met</option>
                <option value="inconclusive">Inconclusive</option>
              </select>
              <textarea
                className="w-full rounded border border-zinc-700 bg-zinc-800 p-2 text-sm"
                placeholder="Lessons learned (optional)"
                value={lessonsLearned}
                onChange={(e) => setLessonsLearned(e.target.value)}
              />
              <button
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                disabled={recordingOutcome}
                onClick={() => void handleRecordOutcome()}
              >
                {recordingOutcome ? "Recording..." : "Record outcome"}
              </button>
            </div>
          ) : (
            <p className="mb-4 text-sm text-zinc-400">
              An outcome can only be recorded once this experiment is running, concluded, or abandoned.
            </p>
          )}

          {outcomesLoading ? (
            <LoadingIndicator className="text-sm text-zinc-400" />
          ) : outcomes.length === 0 ? (
            <p className="text-sm text-zinc-400">No outcomes recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {outcomes.map((o) => (
                <li key={o.outcomeId} className="rounded border border-zinc-700 p-2 text-sm">
                  <div>{o.outcomeData}</div>
                  <div className="text-xs text-zinc-400">
                    {o.criteriaMet} · {formatDisplayDateTime(o.recordedAt)} · {o.recordedBy}
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
          title="Abandon experiment"
          description={`Abandon "${abandonTarget.treatment}"? This is a terminal state -- it cannot be reopened.`}
          confirmLabel="Abandon"
          confirmVariant="danger"
          onCancel={() => setAbandonTarget(null)}
          onConfirm={() => void handleConfirmAbandon()}
        />
      )}

      {executeTarget && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50" onClick={() => setExecuteTarget(null)}>
          <div className="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-900 p-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 font-medium">Execute experiment</h3>
            <p className="mb-3 text-sm text-zinc-400">
              Creates a real Batch from Change Set {executeTarget.changeSetId}&apos;s own approved changes. Dry-run by default;
              a live write additionally requires the Live Writes toggle to already be on in Settings -- otherwise this stays
              dry-run regardless of the choice below.
            </p>
            <div className="mb-4 flex items-center gap-2">
              <ToggleSwitch checked={executeAsLive} onChange={setExecuteAsLive} label="Execute as a live write" />
              <span className="text-sm">Execute as a live write (requires Live Writes already on)</span>
            </div>
            <div className="flex justify-end gap-2">
              <button className="rounded border border-zinc-600 px-3 py-1.5 text-sm" onClick={() => setExecuteTarget(null)}>
                Cancel
              </button>
              <button
                className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                disabled={executing}
                onClick={() => void handleConfirmExecute()}
              >
                {executing ? "Executing..." : "Execute"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
