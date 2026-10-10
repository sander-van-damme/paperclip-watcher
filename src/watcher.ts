import { createHash } from "node:crypto";
import { log } from "./logger.js";
import { PaperclipClient } from "./paperclip-client.js";
import { isWaitingOnHumanReview } from "./review-wait.js";
import type { IssueSummary, WatcherConfig, WatcherState } from "./types.js";
import type { StateStore } from "./state.js";

const TERMINAL = new Set(["done", "cancelled"]);
const WORK = new Set(["todo", "in_progress", "in_review", "blocked"]);
const KNOWN_STATUSES = new Set(["done", "cancelled", "backlog", ...WORK]);
const ACTIVE_RUNS = new Set(["queued", "running", "scheduled_retry"]);
const FAILURE_RUNS = new Set(["failed", "interrupted", "timed_out", "cancelled"]);
const MAX_BLOCKERS_IN_LOG = 30;

interface OutstandingIssueDetail {
  id: string;
  identifier: string | null;
  title: string | null;
  status: string;
}

export interface WatcherPollResult {
  state: string;
  assignedCount: number;
  outstandingCount: number;
  outstandingIssues?: OutstandingIssueDetail[];
  omittedOutstandingCount?: number;
  parkedBacklogCount?: number;
  humanReviewCount?: number;
}

function signature(issues: IssueSummary[], backlogIds: string[] = [], humanReviewIds: string[] = []): string {
  const snapshot = issues.map(issue => [
    issue.id, issue.status, issue.completedAt ?? null, issue.cancelledAt ?? null,
  ]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  // Keep the original signature for ordinary all-terminal work and
  // nonterminal blockers, preserving existing persisted idempotency.
  // Distinguish *eligible* parked work from the same status snapshot when
  // it used to block a wake, including on upgrades.
  const parked = backlogIds.length > 0 || humanReviewIds.length > 0;
  const value = parked
    ? {policy: "passive-wait-v1", snapshot, backlogIds: [...backlogIds].sort(),
       humanReviewIds: [...humanReviewIds].sort()}
    : snapshot;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class PaperclipWatcher {
  private companyId: string | undefined;
  private emptySince: number | null = null;
  private lastObservedSignature: string | null = null;
  private state: WatcherState | null = null;
  constructor(
    private readonly config: WatcherConfig,
    private readonly client: PaperclipClient,
    private readonly stateStore: StateStore,
    private readonly now: () => number = Date.now,
  ) { this.companyId = config.companyId; }

  private async company(): Promise<string> {
    if (this.companyId) return this.companyId;
    const agent = await this.client.getAgent(this.config.ctoAgentId);
    if (!agent.companyId) throw new Error("CTO has no company ID");
    this.companyId = agent.companyId;
    return this.companyId;
  }

  async pollOnce(): Promise<WatcherPollResult> {
    const companyId = await this.company();
    const agent = await this.client.getAgent(this.config.ctoAgentId);
    if (agent.companyId !== companyId) throw new Error("CTO company mismatch");
    // CTO already running: no extra wake is appropriate, but this is not
    // an error. Task-watchdog coverage can still be configured in parallel.
    if (agent.status === "running") return this.reset("agent_running");
    if (!["active", "idle"].includes(agent.status)) return this.reset("agent_unavailable");
    const issues = await this.client.listAssignedIssues(companyId, this.config.ctoAgentId);
    const unknownIssues = issues.filter(issue => !KNOWN_STATUSES.has(issue.status));
    if (unknownIssues.length > 0) {
      return this.blockedResult("unknown_issue_status", issues, unknownIssues);
    }
    if (issues.length === 0) return this.reset("no_assigned_issues");

    const humanReviews = new Set<string>();
    for (const issue of issues) {
      if (issue.status === "in_review" && await isWaitingOnHumanReview(issue, this.client)) {
        humanReviews.add(issue.id);
      }
    }
    const backlogIds = issues.filter(issue => issue.status === "backlog").map(issue => issue.id);
    const humanReviewIds = [...humanReviews];

    const outstandingIssues = issues.filter(issue =>
      WORK.has(issue.status) && !humanReviews.has(issue.id),
    );
    if (outstandingIssues.length > 0) {
      // Preserve the ordinary blocker signature; when the last blocker
      // becomes parked/human-owned, the eligible signature differs.
      if (this.state === null) this.state = await this.stateStore.load();
      const current = signature(issues);
      if (this.state.lastHandledSignature !== current) {
        this.state.lastHandledSignature = current;
        await this.stateStore.save(this.state);
      }
      return {
        ...this.blockedResult("outstanding_issues", issues, outstandingIssues),
        parkedBacklogCount: backlogIds.length,
        humanReviewCount: humanReviewIds.length,
      };
    }
    const passive = backlogIds.length > 0 || humanReviewIds.length > 0;
    const report = {
      assignedCount: issues.length,
      outstandingCount: 0,
      parkedBacklogCount: backlogIds.length,
      humanReviewCount: humanReviewIds.length,
    };
    const runs = await this.client.listAgentRuns(companyId, this.config.ctoAgentId);
    if (runs.some(run => ACTIVE_RUNS.has(run.status))) return this.reset("active_or_retrying_run", issues.length);
    if (runs.some(run => !ACTIVE_RUNS.has(run.status) && !["succeeded", ...FAILURE_RUNS].includes(run.status))) {
      return this.reset("unknown_run_status", issues.length);
    }
    const mostRecent = runs[0];
    if (!mostRecent || mostRecent.status !== "succeeded" || mostRecent.livenessState === "blocked") {
      return this.reset("last_run_not_successful", issues.length);
    }

    const sig = signature(issues, backlogIds, humanReviewIds);
    if (this.state === null) this.state = await this.stateStore.load();
    // Finished work is woken once per snapshot. Parked backlog and reviews
    // waiting on humans may be re-woken after cooldown because no agent
    // work is currently actionable. This keeps research moving while a
    // human decision is outstanding, without 15-second wakeup storms.
    if (!passive && this.state.lastHandledSignature === sig && this.state.lastWakeAt !== null) {
      return { state: "already_handled", ...report };
    }
    if (this.lastObservedSignature !== sig) {
      this.lastObservedSignature = sig;
      this.emptySince = this.now();
      return { state: "settling", ...report };
    }
    if (this.emptySince === null) this.emptySince = this.now();
    if (this.now() - this.emptySince < this.config.idleGraceMs) return { state: "settling", ...report };
    if (this.state.lastWakeAt !== null && this.now() - this.state.lastWakeAt < this.config.cooldownMs) {
      return { state: "cooldown", ...report };
    }

    // Persist *before* invoking. An uncertain network response must not
    // cause repeated wakes. Operators can manually reset the state file.
    this.state.lastHandledSignature = sig;
    this.state.lastWakeAt = this.now();
    if (!this.config.dryRun) {
      await this.stateStore.save(this.state);
      // A parked snapshot can legitimately get multiple wakes over time.
      // Give each bounded attempt its own idempotency key; the persisted
      // lastWakeAt suppresses duplicate attempts on uncertain responses.
      const wakeKey = "paperclip-watcher:idle:" + sig + (passive ? ":" + this.state.lastWakeAt : "");
      const result = await this.client.wakeCto(this.config.ctoAgentId, wakeKey);
      log("info", "CTO wake requested", { resultStatus: result.status });
    }
    this.emptySince = null;
    return { state: this.config.dryRun ? "dry_run" : "woken", ...report };
  }

  private reset(state: string, assignedCount = 0): WatcherPollResult {
    this.emptySince = null;
    this.lastObservedSignature = null;
    return { state, assignedCount, outstandingCount: 0 };
  }

  private blockedResult(state: string, allIssues: IssueSummary[], blockers: IssueSummary[]): WatcherPollResult {
    const result = this.reset(state, allIssues.length);
    return {
      ...result,
      outstandingCount: blockers.length,
      outstandingIssues: blockers.slice(0, MAX_BLOCKERS_IN_LOG).map(issue => ({
        id: issue.id,
        identifier: issue.identifier ?? null,
        title: issue.title ?? null,
        status: issue.status,
      })),
      omittedOutstandingCount: Math.max(0, blockers.length - MAX_BLOCKERS_IN_LOG),
    };
  }
}
