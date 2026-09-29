"use client";

import { useCallback, useEffect, useState } from "react";
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

// Phase 10 slice 1 (docs/roadmap/plans/PHASE_10_SLICE_1_PLAN.md) -- manual-entry record-keeping
// for hypotheses -> experiments -> outcomes. No AI-generated hypotheses, no automatic execution
// (FUTURE_PHASES.md §6's own non-goals for this slice).
// `channel` is the dashboard's own currently-active owned channel (nullable -- e.g. no channel
// connected yet). Optional here because a hypothesis can be scoped to it (owner spec §6 case (A),
// "optimizing existing channels") or left channel-less (case (B), "new channel concept") -- the
// toggle below lets an operator pick per hypothesis, matching this app's standing rule that any
// boolean ON/OFF control uses the shared ToggleSwitch, never a native checkbox.
export function DecisionsManager({ channel }: { channel: ChannelInfo | null }) {
  const [hypotheses, setHypotheses] = useState<Hypothesis[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newStatement, setNewStatement] = useState("");
  const [newEvidenceNotes, setNewEvidenceNotes] = useState("");
  const [scopeToChannel, setScopeToChannel] = useState(false);
  const [creatingHypothesis, setCreatingHypothesis] = useState(false);

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

  function handleSelectHypothesis(hypothesisId: string) {
    setSelectedHypothesisId(hypothesisId);
    setSelectedExperimentId(null);
    setOutcomes([]);
    void fetchExperiments(hypothesisId);
  }

  function handleSelectExperiment(experimentId: string) {
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
        <h3 className="mb-3 font-medium">Hypotheses</h3>
        {loading ? (
          <p className="text-sm text-zinc-400">Loading...</p>
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
            <p className="text-sm text-zinc-400">Loading...</p>
          ) : experiments.length === 0 ? (
            <p className="text-sm text-zinc-400">No experiments yet.</p>
          ) : (
            <ul className="space-y-2">
              {experiments.map((exp) => (
                <li key={exp.experimentId} className="rounded border border-zinc-700 p-2">
                  <button className="w-full text-left text-sm" onClick={() => handleSelectExperiment(exp.experimentId)}>
                    <div className="font-medium">{exp.treatment}</div>
                    <div className="text-xs text-zinc-400">
                      {STATUS_LABELS[exp.status]}
                      {exp.approvedBy ? ` · approved by ${exp.approvedBy}` : ""}
                    </div>
                  </button>
                  <div className="mt-2 flex gap-2">
                    {NEXT_STATUSES[exp.status].map((target) =>
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
                  </div>
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
            <p className="text-sm text-zinc-400">Loading...</p>
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
    </div>
  );
}
