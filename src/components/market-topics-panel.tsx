"use client";

import { FeatureErrorBoundary } from "./feature-error-boundary";
import { MarketChannelAssignment } from "./market-channel-assignment";
import { useCallback, useEffect, useRef, useState } from "react";
import { TopicWikipediaSignals } from "./topic-wikipedia-signals";
import { InfoTooltip } from "./info-tooltip";
import { ConfirmDialog } from "./confirm-dialog";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { LoadingIndicator } from "./operation-progress";

type MarketTopic = {
  topicId: string;
  name: string;
  addedAt: string;
};

type MarketTopicAssignment = {
  assignmentId: string;
  topicId: string;
  subjectType: "channel" | "video";
  subjectId: string;
  source: "manual" | "ai_assisted";
  assignedAt: string;
};

// Phase 9 slice 9E, part A (docs/roadmap/plans/PHASE_9_SLICE_9E_PLAN.md §7) -- minimal topic-model
// UI: create/list/delete topics, and manually assign a watchlisted channel or a video id to one.
// Manual/keyword-based tagging only -- no AI-assisted classification anywhere in this component
// (owner decision 3's own AI-gating exemption for this exact case).
export function MarketTopicsPanel() {
  const [topics, setTopics] = useState<MarketTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTopicName, setNewTopicName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MarketTopic | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [expandedTopicId, setExpandedTopicId] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<MarketTopicAssignment[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [newSubjectType, setNewSubjectType] = useState<"channel" | "video">("channel");
  const [newSubjectId, setNewSubjectId] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  // Tracks which topic the most recently STARTED fetchAssignments call was for, so a slower,
  // now-stale response (e.g. from a topic the user already collapsed and moved on from) never
  // overwrites a newer one that already landed (found by independent code review).
  const assignmentsRequestTopicIdRef = useRef<string | null>(null);

  const fetchTopics = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/market-intelligence/topics");
      if (res.ok) {
        const data = await res.json();
        setTopics(data.topics ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTopics();
  }, [fetchTopics]);

  const fetchAssignments = useCallback(async (topicId: string) => {
    assignmentsRequestTopicIdRef.current = topicId;
    setAssignmentsLoading(true);
    try {
      const res = await fetch(`/api/market-intelligence/topics/${encodeURIComponent(topicId)}/assignments`);
      if (res.ok) {
        const data = await res.json();
        if (assignmentsRequestTopicIdRef.current === topicId) {
          setAssignments(data.assignments ?? []);
        }
      }
    } finally {
      if (assignmentsRequestTopicIdRef.current === topicId) setAssignmentsLoading(false);
    }
  }, []);

  function handleToggleExpand(topic: MarketTopic) {
    if (expandedTopicId === topic.topicId) {
      setExpandedTopicId(null);
      return;
    }
    setExpandedTopicId(topic.topicId);
    setAssignError(null);
    void fetchAssignments(topic.topicId);
  }

  async function handleCreateTopic() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/market-intelligence/topics", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: newTopicName }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "Failed to create topic");
        return;
      }
      setNewTopicName("");
      await fetchTopics();
    } finally {
      setCreating(false);
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/market-intelligence/topics/${encodeURIComponent(deleteTarget.topicId)}`, { method: "DELETE" });
      // Found by independent code review: an earlier version treated this as successful
      // unconditionally, closing the dialog even on a rejected (e.g. expired-session) delete with
      // no indication anything went wrong.
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.message ?? "Failed to delete topic");
        return;
      }
      if (expandedTopicId === deleteTarget.topicId) setExpandedTopicId(null);
      setDeleteTarget(null);
      await fetchTopics();
    } finally {
      setDeleting(false);
    }
  }

  async function handleAssign(topicId: string) {
    setAssigning(true);
    setAssignError(null);
    try {
      const res = await fetch(`/api/market-intelligence/topics/${encodeURIComponent(topicId)}/assignments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectType: newSubjectType, subjectId: newSubjectId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAssignError(data.message ?? "Failed to assign");
        return;
      }
      setNewSubjectId("");
      await fetchAssignments(topicId);
    } finally {
      setAssigning(false);
    }
  }

  async function handleRemoveAssignment(topicId: string, assignmentId: string) {
    setAssignError(null);
    const res = await fetch(`/api/market-intelligence/topic-assignments/${encodeURIComponent(assignmentId)}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setAssignError(data.message ?? "Failed to remove assignment");
      return;
    }
    await fetchAssignments(topicId);
  }

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          Topics
          <InfoTooltip>
            A manually-defined list of topic labels (e.g. &ldquo;night jazz bar&rdquo;), which you
            can tag onto a watchlisted channel or a video id. Manual/keyword-based tagging only --
            no AI-assisted classification here.
          </InfoTooltip>
        </h3>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={newTopicName}
          onChange={(e) => setNewTopicName(e.target.value)}
          placeholder="New topic name"
          className="min-w-56 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
        />
        <button
          onClick={handleCreateTopic}
          disabled={creating || newTopicName.trim().length === 0}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
        >
          {creating ? "Adding..." : "Add topic"}
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && topics.length === 0 && <p className="text-sm text-zinc-500">No topics yet.</p>}

      <div className="space-y-2">
        {topics.map((topic) => (
          <div key={topic.topicId} className="rounded-lg border border-zinc-800 p-3">
            <div className="mb-2">
              <FeatureErrorBoundary label="Channel assignment">
                <MarketChannelAssignment recordKind="topic" recordId={topic.topicId} />
              </FeatureErrorBoundary>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button onClick={() => handleToggleExpand(topic)} className="text-left text-sm font-medium text-zinc-100 hover:underline">
                {topic.name}
              </button>
              <button
                onClick={() => setDeleteTarget(topic)}
                className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-red-700 hover:text-red-400"
              >
                Delete
              </button>
            </div>

            {expandedTopicId === topic.topicId && (
              <div className="mt-3 space-y-2 border-t border-zinc-800 pt-3">
                <FeatureErrorBoundary label="Research — Wikipedia interest">
                  <TopicWikipediaSignals topicId={topic.topicId} />
                </FeatureErrorBoundary>
                {assignmentsLoading && <LoadingIndicator className="text-xs text-zinc-500" />}
                {!assignmentsLoading && assignments.length === 0 && <p className="text-xs text-zinc-500">No assignments yet.</p>}
                {assignments.map((assignment) => (
                  <div key={assignment.assignmentId} className="flex items-center justify-between gap-2 text-xs text-zinc-300">
                    <span>
                      {assignment.subjectType}: {assignment.subjectId} &middot; {formatDisplayDateTime(assignment.assignedAt)}
                    </span>
                    <button
                      onClick={() => handleRemoveAssignment(topic.topicId, assignment.assignmentId)}
                      className="rounded-md border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:border-red-700 hover:text-red-400"
                    >
                      Remove
                    </button>
                  </div>
                ))}

                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <select
                    value={newSubjectType}
                    onChange={(e) => setNewSubjectType(e.target.value as "channel" | "video")}
                    className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                  >
                    <option value="channel">Channel</option>
                    <option value="video">Video</option>
                  </select>
                  <input
                    value={newSubjectId}
                    onChange={(e) => setNewSubjectId(e.target.value)}
                    placeholder={newSubjectType === "channel" ? "UC..." : "video id"}
                    className="min-w-48 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                  />
                  <button
                    onClick={() => handleAssign(topic.topicId)}
                    disabled={assigning || newSubjectId.trim().length === 0}
                    className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    Assign
                  </button>
                </div>
                {assignError && <p className="text-xs text-red-400">{assignError}</p>}
              </div>
            )}
          </div>
        ))}
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this topic?"
          description={`This removes "${deleteTarget.name}" and every assignment tagged with it. Any trend candidate tagged with this topic keeps its own evidence, just without this topic label.`}
          confirmLabel={deleting ? "Deleting..." : "Delete"}
          confirmVariant="danger"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleConfirmDelete}
        />
      )}
    </div>
  );
}
