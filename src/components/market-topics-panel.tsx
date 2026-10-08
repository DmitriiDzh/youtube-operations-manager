"use client";

import { FeatureErrorBoundary } from "./feature-error-boundary";
import { MarketChannelAssignment, useMarketAssignments, VisibleToPill } from "./market-channel-assignment";
import { DrawerSection, SideDrawer } from "./side-drawer";
import { useCallback, useEffect, useRef, useState } from "react";
import { TopicWikipediaSignals } from "./topic-wikipedia-signals";
import { InfoTooltip } from "./info-tooltip";
import { ConfirmDialog } from "./confirm-dialog";
import { formatDisplayDateTime } from "@/lib/shared-formatting";
import { LoadingIndicator } from "./operation-progress";
import { useT } from "./ui-text-provider";

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
// (owner decision 3's own AI-gating exemption for this exact case). BL-140 R5: a compact list; a topic's
// assignments, Wikipedia interest and visibility open in a side panel.
export function MarketTopicsPanel() {
  const t = useT();
  const [topics, setTopics] = useState<MarketTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTopicName, setNewTopicName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MarketTopic | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [expandedTopicId, setExpandedTopicId] = useState<string | null>(null);
  const { assignments: visibility, connectedChannels, set: setVisibility } = useMarketAssignments("topic");
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

  function handleOpen(topic: MarketTopic) {
    setAssignments([]);
    setExpandedTopicId(topic.topicId);
    setAssignError(null);
    void fetchAssignments(topic.topicId);
  }

  const openTopic = topics.find((topic) => topic.topicId === expandedTopicId) ?? null;
  const closeTopic = useCallback(() => {
    setExpandedTopicId(null);
    // The stale-response guard too, so a late reply for the closed topic is dropped.
    assignmentsRequestTopicIdRef.current = null;
  }, []);

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
        setError(data.message ?? t("topics.createFailed"));
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
        setError(data.message ?? t("topics.deleteFailed"));
        return;
      }
      if (expandedTopicId === deleteTarget.topicId) closeTopic();
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
        setAssignError(data.message ?? t("topics.assignFailed"));
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
      setAssignError(data.message ?? t("topics.removeAssignmentFailed"));
      return;
    }
    await fetchAssignments(topicId);
  }

  return (
    <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-base font-semibold text-zinc-100">
          {t("topics.title")}
          <InfoTooltip>{t("topics.info")}</InfoTooltip>
        </h3>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={newTopicName}
          onChange={(e) => setNewTopicName(e.target.value)}
          placeholder={t("topics.newPlaceholder")}
          className="min-w-56 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
        />
        <button
          onClick={handleCreateTopic}
          disabled={creating || newTopicName.trim().length === 0}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
        >
          {creating ? t("topics.adding") : t("topics.add")}
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && topics.length === 0 && <p className="text-sm text-zinc-500">{t("topics.empty")}</p>}

      {topics.length > 0 && (
        <div className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {topics.map((topic) => (
            <button
              key={topic.topicId}
              type="button"
              onClick={() => handleOpen(topic)}
              className={`flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left hover:bg-zinc-800/50 ${expandedTopicId === topic.topicId ? "bg-zinc-800/50" : ""}`}
            >
              <span className="text-sm font-medium text-zinc-100">{topic.name}</span>
              <span className="flex items-center gap-2 text-xs text-zinc-500">
                {t("topics.added", { date: formatDisplayDateTime(topic.addedAt) })}
                <VisibleToPill channelIds={visibility.get(topic.topicId) ?? []} connectedChannels={connectedChannels} />
              </span>
            </button>
          ))}
        </div>
      )}

      {openTopic && (
        <SideDrawer title={openTopic.name} subtitle={t("topics.drawerSubtitle", { date: formatDisplayDateTime(openTopic.addedAt) })} onClose={closeTopic}>
          <DrawerSection title={t("signals.title")}>
            <FeatureErrorBoundary label={t("topics.wikipediaBoundary")}>
              <TopicWikipediaSignals topicId={openTopic.topicId} />
            </FeatureErrorBoundary>
          </DrawerSection>

          <DrawerSection title={t("topics.tagged")}>
            {assignmentsLoading && <LoadingIndicator className="text-xs text-zinc-500" />}
            {!assignmentsLoading && assignments.length === 0 && <p className="text-xs text-zinc-500">{t("topics.nothingTagged")}</p>}
            {assignments.map((assignment) => (
              <div key={assignment.assignmentId} className="flex items-center justify-between gap-2 text-xs text-zinc-300">
                <span>
                  {t("topics.assignmentRow", {
                    subjectType: t(assignment.subjectType === "channel" ? "topics.subject.channel" : "topics.subject.video"),
                    subjectId: assignment.subjectId,
                    date: formatDisplayDateTime(assignment.assignedAt),
                  })}
                </span>
                <button
                  onClick={() => handleRemoveAssignment(openTopic.topicId, assignment.assignmentId)}
                  className="rounded-md border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:border-red-700 hover:text-red-400"
                >
                  {t("topics.remove")}
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <select
                value={newSubjectType}
                onChange={(e) => setNewSubjectType(e.target.value as "channel" | "video")}
                aria-label={t("topics.subjectTypeLabel")}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
              >
                <option value="channel">{t("topics.optionChannel")}</option>
                <option value="video">{t("topics.optionVideo")}</option>
              </select>
              <input
                value={newSubjectId}
                onChange={(e) => setNewSubjectId(e.target.value)}
                placeholder={newSubjectType === "channel" ? "UC..." : t("topics.videoIdPlaceholder")}
                className="min-w-48 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
              />
              <button
                onClick={() => handleAssign(openTopic.topicId)}
                disabled={assigning || newSubjectId.trim().length === 0}
                className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {t("topics.assign")}
              </button>
            </div>
            {assignError && <p className="text-xs text-red-400">{assignError}</p>}
          </DrawerSection>

          <DrawerSection title={t("requests.visibleTo")}>
            <FeatureErrorBoundary label={t("requests.channelAssignment")}>
              <MarketChannelAssignment recordKind="topic" recordId={openTopic.topicId} onChange={(channelIds) => setVisibility(openTopic.topicId, channelIds)} />
            </FeatureErrorBoundary>
          </DrawerSection>

          <DrawerSection title={t("topics.deleteSection")}>
            <button
              onClick={() => setDeleteTarget(openTopic)}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-red-700 hover:text-red-400"
            >
              {t("topics.deleteTopic")}
            </button>
            {error && <p className="text-xs text-red-400">{error}</p>}
          </DrawerSection>
        </SideDrawer>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={t("topics.deleteConfirmTitle")}
          description={t("topics.deleteConfirmBody", { name: deleteTarget.name })}
          confirmLabel={deleting ? t("topics.deleting") : t("topics.delete")}
          confirmVariant="danger"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleConfirmDelete}
        />
      )}
    </div>
  );
}
