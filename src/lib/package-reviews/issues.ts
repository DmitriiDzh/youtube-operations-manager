import type { PackageReviewDecision } from "./contracts";
import { byTimeThenId, isGateDecision } from "./model";
import { clockOf, wellFormedTimedComments, withIssueIds, type IssueReply } from "./timed-comments";

// Owner TG 4846 (PACKAGE_REVIEW_PLAN.md AC-IS-01..08): the owner's timed comments as ISSUES that outlive the package version they were
// made on. Pure: the decisions of one video (any manifest, any mp4) and the current package's `reviewReplies` in, the issues out. The
// result depends only on those inputs, so the wake file rendered from one decision is the same on either computer (AC-RN-16).

/** One turn of an issue's thread. */
export type IssueTurn =
  | { by: "owner"; kind: "opened" | "follow_up" | "resolved"; text: string | null; at: string }
  /** `at`: the decision that saw the answer, or null while it is only in the current package (not decided on yet). */
  | { by: "agent"; status: IssueReply["status"]; text: string; atSeconds: number | null; at: string | null };

export type IssueState = "open" | "resolved" | "noted";

export type ReviewIssue = {
  id: string;
  /** The moment now: the agent's latest `atSeconds`, else where the owner put it. */
  atSeconds: number;
  /** Where the owner put it. */
  originalAtSeconds: number;
  /** The owner's comment that opened it. */
  text: string;
  state: IssueState;
  /** The decision that opened it. */
  openedIn: string;
  thread: IssueTurn[];
};

export type IssueCounts = { open: number; resolved: number; noted: number };

/**
 * AC-IS-01: the decisions about one video -- its own code, or a decision under the code the video was recoded from (BL-263 alias),
 * the rule packaging comments use; approvals and returns only, in the document's order.
 */
export function decisionsOfVideo(decisions: readonly PackageReviewDecision[], video: string, aliases: ReadonlyMap<string, string>): PackageReviewDecision[] {
  return decisions.filter((d) => isGateDecision(d) && d.video !== "" && (d.video === video || aliases.get(d.video) === video)).sort(byTimeThenId);
}

const sameAgentTurn = (a: IssueTurn | undefined, r: IssueReply) => a?.by === "agent" && a.status === r.status && a.text === r.text && a.atSeconds === (r.atSeconds ?? null);

/**
 * The issues of one video from its decisions (oldest first) and the current package's replies (`pending`, not yet seen in a decision).
 * Per decision: the answers it saw come first (the factory answered before the owner looked), then the issues it opens (an approval's
 * are `noted`, a return's `open`), then the owner's actions (`resolved`; `follow_up` -- open again). A carried copy of a decision adds
 * nothing twice (issues by id, turns by content). A reply or an action to an unknown issue is ignored.
 */
export function issuesOf(decisions: readonly PackageReviewDecision[], pending: readonly IssueReply[] = []): ReviewIssue[] {
  const issues = new Map<string, ReviewIssue>();
  const lastAgent = (issue: ReviewIssue) => [...issue.thread].reverse().find((t) => t.by === "agent");
  const addReply = (r: IssueReply, at: string | null) => {
    const issue = issues.get(r.issueId);
    if (!issue || sameAgentTurn(lastAgent(issue), r)) return;
    issue.thread.push({ by: "agent", status: r.status, text: r.text, atSeconds: r.atSeconds ?? null, at });
    if (r.atSeconds !== undefined) issue.atSeconds = r.atSeconds;
  };
  const seenOwnerTurns = new Set<string>();
  for (const d of decisions) {
    for (const r of d.repliesSeen ?? []) addReply(r, d.at);
    for (const c of withIssueIds(d.id, wellFormedTimedComments(d.timedComments))) {
      if (issues.has(c.id!)) continue;
      issues.set(c.id!, {
        id: c.id!,
        atSeconds: c.atSeconds,
        originalAtSeconds: c.atSeconds,
        text: c.text,
        state: d.kind === "returned" ? "open" : "noted",
        openedIn: d.id,
        thread: [{ by: "owner", kind: "opened", text: c.text, at: d.at }],
      });
    }
    for (const a of d.issueActions ?? []) {
      const issue = issues.get(a.issueId);
      const key = `${a.issueId}|${a.kind}|${a.text ?? ""}|${d.at}`;
      if (!issue || seenOwnerTurns.has(key)) continue;
      seenOwnerTurns.add(key);
      issue.thread.push({ by: "owner", kind: a.kind, text: a.kind === "follow_up" ? (a.text ?? null) : null, at: d.at });
      issue.state = a.kind === "resolved" ? "resolved" : "open";
    }
  }
  // A pending answer that is already the last one seen adds nothing.
  for (const r of pending) {
    const issue = issues.get(r.issueId);
    if (issue && !sameAgentTurn(lastAgent(issue), r)) addReply(r, null);
  }
  return [...issues.values()].sort((a, b) => a.atSeconds - b.atSeconds || a.id.localeCompare(b.id));
}

export function issueCounts(issues: readonly ReviewIssue[]): IssueCounts {
  return {
    open: issues.filter((i) => i.state === "open").length,
    resolved: issues.filter((i) => i.state === "resolved").length,
    noted: issues.filter((i) => i.state === "noted").length,
  };
}

/** What the agents read per issue (AC-IS-07): id, the moment (seconds and `m:ss`), state, the thread with each turn's time spelt out. */
export type IssueReadout = {
  id: string;
  atSeconds: number;
  time: string;
  state: IssueState;
  thread: Array<{ by: "owner" | "agent"; kind?: "opened" | "follow_up" | "resolved"; status?: IssueReply["status"]; text: string | null; atSeconds?: number; time?: string; at: string | null }>;
};

export function issuesReadout(issues: readonly ReviewIssue[]): IssueReadout[] {
  return issues.map((i) => ({
    id: i.id,
    atSeconds: i.atSeconds,
    time: clockOf(i.atSeconds),
    state: i.state,
    thread: i.thread.map((t) =>
      t.by === "owner"
        ? { by: "owner" as const, kind: t.kind, text: t.text, at: t.at }
        : { by: "agent" as const, status: t.status, text: t.text, ...(t.atSeconds !== null ? { atSeconds: t.atSeconds, time: clockOf(t.atSeconds) } : {}), at: t.at }
    ),
  }));
}
