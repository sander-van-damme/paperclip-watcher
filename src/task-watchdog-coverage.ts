import { log } from "./logger.js";
import { PaperclipClient } from "./paperclip-client.js";
import type { WatcherConfig, IssueSummary, AgentSummary } from "./types.js";
import type { TaskWatchdogCoverageStore } from "./task-watchdog-state.js";

const INVESTIGABLE = new Set(["todo", "in_progress", "in_review", "blocked"]);
const LIVE_RUNS = new Set(["queued", "running", "scheduled_retry"]);
const ACTIONABLE_BLOCKERS = new Set([
  "blocked_by_unassigned_issue", "blocked_by_assigned_backlog_issue",
  "blocked_by_uninvokable_assignee", "blocked_by_cancelled_issue",
  "blocked_chain_stalled", "invalid_review_participant",
  "in_review_without_action_path", "missing_successful_run_disposition",
]);
// Seeing a failed run once is not an incident. Confirm the same unresolved
// signal across polls before opting into Paperclip's native task watchdog.
const PROBLEM_CONFIRM_MS = 10 * 60_000;
const MAX_PARENT_DEPTH = 100;
// Paperclip's invokable agent statuses include "running" (and "error").
// Coverage registration is a control-plane write, not a request to start
// another execution, so it must not wait for the CTO to become idle.
const INVOKABLE_STATUSES = new Set(["active", "idle", "running", "error"]);

export interface TaskWatchdogCoveragePollResult {
  candidates: number;
  eligible: number;
  alreadyConfigured: number;
  attached: number;
  dryRunCandidates: number;
  skippedKnown: number;
  coveredByAncestor: number;
  deferredByLimit: number;
  detectedProblems: number;
  settlingProblems: number;
}

/**
 * Opt into a native CEO task watchdog ONLY after the same evidence-backed
 * operational stall persists. Normal completion must never trigger a review.
 * Existing watchdogs remain untouched. This service only attaches watchdogs;
 * Paperclip itself handles the stopped-subtree review and repair.
 */
export class TaskWatchdogCoverageSupervisor {
  private known: Set<string> | null = null;
  private readonly observedProblems = new Map<string, { reason: string; since: number }>();

  constructor(
    private readonly config: WatcherConfig,
    private readonly client: PaperclipClient,
    private readonly store: TaskWatchdogCoverageStore,
    private readonly now: () => number = Date.now,
  ) {}

  private async stalledReason(issue: IssueSummary): Promise<string | null> {
    // Issue state can change between list and detail reads. Never use stale
    // or ambiguous evidence to configure a native watchdog.
    const detail = await this.client.getIssue(issue.id);
    if (detail.id !== issue.id || detail.companyId !== issue.companyId ||
        detail.assigneeAgentId !== this.config.ctoAgentId ||
        detail.status !== issue.status || detail.parentId !== issue.parentId) return null;

    if (detail.activeRun && LIVE_RUNS.has(detail.activeRun.status)) return null;
    if (detail.scheduledRetry && LIVE_RUNS.has(detail.scheduledRetry.status)) return null;

    if (detail.status === "in_review") {
      return detail.reviewAttention?.state === "stalled" ? "stalled_review" : null;
    }

    if (detail.status === "blocked") {
      const attention = detail.blockedInboxAttention;
      if (!attention || !["needs_attention", "missing_disposition"].includes(attention.state) ||
          !ACTIONABLE_BLOCKERS.has(attention.reason) ||
          attention.owner?.type === "user" || attention.owner?.type === "external") return null;
      return "blocked_attention:" + attention.reason;
    }

    if (detail.status !== "todo" && detail.status !== "in_progress") return null;
    // Paperclip owns any active source-scoped recovery. Do not race or
    // duplicate its bounded retry, monitor, escalation or human wait path.
    if (detail.activeRecoveryAction?.status === "active") return null;

    const runs = await this.client.listIssueRuns(issue.id);
    const latest = runs
      .filter(run => run.agentId === this.config.ctoAgentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!latest || !["failed", "timed_out"].includes(latest.status) ||
        ["provider_quota", "rate_limit", "issue_dependencies_blocked",
         "issue_terminal_status", "issue_cancelled"].includes(latest.errorCode ?? "")) return null;
    // Key observation by run identity. A new attempt resets the grace period.
    return "terminal_failure:" + latest.runId + ":" + latest.status;
  }

  private async remember(issueId: string): Promise<void> {
    if (!this.known) throw new Error("Task watchdog tracking state not loaded");
    if (this.known.has(issueId)) return;
    // Remember any watchdog seen or attached. If a human later disables it,
    // do not silently restore it after the next poll/reboot.
    await this.store.save([...this.known, issueId]);
    this.known.add(issueId);
  }

  private async resolveCeo(companyId: string): Promise<AgentSummary> {
    if (this.config.ceoAgentId) return this.client.getAgent(this.config.ceoAgentId);
    const agents = await this.client.listCompanyAgents(companyId);
    const matches = agents.filter(agent => agent.role === "ceo");
    if (matches.length !== 1) {
      throw new Error("Expected exactly one CEO agent; set PAPERCLIP_CEO_AGENT_ID explicitly if needed");
    }
    return matches[0]!;
  }

  async pollOnce(): Promise<TaskWatchdogCoveragePollResult> {
    if (this.known === null) this.known = new Set(await this.store.load());

    const cto = await this.client.getAgent(this.config.ctoAgentId);
    if (!cto.companyId || (this.config.companyId && this.config.companyId !== cto.companyId)) {
      throw new Error("CTO company mismatch");
    }
    const ceo = await this.resolveCeo(cto.companyId);
    if (ceo.companyId !== cto.companyId) throw new Error("CEO / CTO company mismatch");
    if (cto.role !== "cto" || ceo.role !== "ceo" || cto.id === ceo.id) {
      throw new Error("Configured agents must be distinct CTO and CEO agents");
    }
    if (!INVOKABLE_STATUSES.has(cto.status) || !INVOKABLE_STATUSES.has(ceo.status)) {
      throw new Error("CTO or CEO is not invokable; skip task watchdog attachment");
    }

    const assigned = await this.client.listAssignedIssues(cto.companyId, cto.id);
    const byId = new Map(assigned.map(issue => [issue.id, issue]));
    const remoteParents = new Map<string, IssueSummary>();
    const ancestorWatchdogs = new Map<string, boolean>();
    const loadParent = async (id: string): Promise<IssueSummary> => {
      const cached = byId.get(id) ?? remoteParents.get(id);
      if (cached) return cached;
      const fetched = await this.client.getIssue(id);
      if (!fetched || fetched.id !== id || fetched.companyId !== cto.companyId) {
        throw new Error("Invalid parent issue lookup for " + id);
      }
      remoteParents.set(id, fetched);
      return fetched;
    };
    const parentHasWatchdog = async (id: string): Promise<boolean> => {
      const cached = ancestorWatchdogs.get(id);
      if (cached !== undefined) return cached;
      const exists = (await this.client.getTaskWatchdog(id)) !== null;
      if (exists) await this.remember(id);
      ancestorWatchdogs.set(id, exists);
      return exists;
    };

    const coveredByParent = async (issue: IssueSummary): Promise<boolean> => {
      const visited = new Set<string>([issue.id]);
      let parentId = issue.parentId;
      for (let depth = 0; parentId !== null; depth++) {
        if (parentId === undefined || depth >= MAX_PARENT_DEPTH || visited.has(parentId)) {
          throw new Error("Incomplete or cyclic task ancestry for " + issue.id);
        }
        visited.add(parentId);
        const parent = await loadParent(parentId);
        if (parent.parentId === undefined) throw new Error("Parent issue missing parentId: " + parent.id);
        if (parent.originKind === "task_watchdog") return true;
        // Do not assume an active CTO ancestor has a watchdog. Under selective
        // coverage a healthy parent must not hide a genuinely stuck child.
        // Respect both existing parent watchers and past explicit removals
        // known to this service.
        if (this.known!.has(parent.id) || await parentHasWatchdog(parent.id)) return true;
        parentId = parent.parentId;
      }
      return false;
    };

    const candidates = assigned.filter(issue => {
      if (issue.parentId === undefined || issue.originKind === undefined) {
        throw new Error("Issue list omitted task ancestry/origin fields for " + issue.id);
      }
      return INVESTIGABLE.has(issue.status) && issue.originKind !== "task_watchdog";
    });
    // Prefer parents if both a parent and a child independently show a stall.
    const depth = (issue: IssueSummary): number => {
      const visited = new Set([issue.id]);
      let parentId = issue.parentId, result = 0;
      while (parentId && byId.has(parentId) && !visited.has(parentId)) {
        visited.add(parentId);
        result++;
        parentId = byId.get(parentId)!.parentId;
      }
      return result;
    };
    candidates.sort((a, b) => depth(a) - depth(b) || a.id.localeCompare(b.id));
    const candidatesIds = new Set(candidates.map(issue => issue.id));
    for (const id of this.observedProblems.keys()) {
      if (!candidatesIds.has(id)) this.observedProblems.delete(id);
    }
    const result: TaskWatchdogCoveragePollResult = {
      candidates: candidates.length,
      eligible: 0,
      alreadyConfigured: 0,
      attached: 0,
      dryRunCandidates: 0,
      skippedKnown: 0,
      coveredByAncestor: 0,
      deferredByLimit: 0,
      detectedProblems: 0,
      settlingProblems: 0,
    };

    for (const issue of candidates) {
      if (await coveredByParent(issue)) {
        result.coveredByAncestor += 1;
        this.observedProblems.delete(issue.id);
        continue;
      }
      if (this.known.has(issue.id)) {
        result.skippedKnown += 1;
        this.observedProblems.delete(issue.id);
        continue;
      }
      const existing = await this.client.getTaskWatchdog(issue.id);
      if (existing !== null) {
        // Leave all existing (including manually configured) watchdogs alone.
        await this.remember(issue.id);
        result.alreadyConfigured += 1;
        this.observedProblems.delete(issue.id);
        continue;
      }

      const reason = await this.stalledReason(issue);
      if (!reason) {
        this.observedProblems.delete(issue.id);
        continue;
      }
      result.detectedProblems += 1;
      const observed = this.observedProblems.get(issue.id);
      if (!observed || observed.reason !== reason) {
        this.observedProblems.set(issue.id, { reason, since: this.now() });
        result.settlingProblems += 1;
        continue;
      }
      if (this.now() - observed.since < PROBLEM_CONFIRM_MS) {
        result.settlingProblems += 1;
        continue;
      }

      result.eligible += 1;
      if (!this.config.dryRun && result.attached >= this.config.taskWatchdogMaxAttachmentsPerPoll) {
        result.deferredByLimit += 1;
        continue;
      }
      if (this.config.dryRun) {
        result.dryRunCandidates += 1;
        continue;
      }

      // Re-read authoritative issue and watchdog state immediately before
      // the write; a task might have completed, retried or gained coverage.
      if (await this.stalledReason(issue) !== reason) {
        this.observedProblems.delete(issue.id);
        continue;
      }
      const rechecked = await this.client.getTaskWatchdog(issue.id);
      if (rechecked !== null) {
        await this.remember(issue.id);
        result.alreadyConfigured += 1;
        this.observedProblems.delete(issue.id);
        continue;
      }
      const instructions = [
        this.config.taskWatchdogInstructions,
        "Operational stall detected by Paperclip Watcher after at least 10 minutes: " + reason + ". " +
        "This is not a routine completion review. If the work already resumed, completed, or has a " +
        "legitimate wait, preserve its truthful state and do not create replacement engineering.",
      ].join("\n\n");
      const installed = await this.client.putTaskWatchdog(
        issue.id, ceo.id, instructions,
      );
      if (installed.issueId !== issue.id ||
          installed.watchdogAgentId !== ceo.id ||
          installed.status !== "active") {
        throw new Error("Unexpected Paperclip watchdog response for " + issue.id);
      }
      await this.remember(issue.id);
      this.observedProblems.delete(issue.id);
      result.attached += 1;
      log("info", "CEO task watchdog attached for stalled work", {
        issue: issue.identifier ?? issue.id,
        reason,
        ceoAgentId: ceo.id,
      });
      // Other potential tasks are still inspected for coverage, but deferred
      // until a later scan once the attachment limit has been reached.
    }
    return result;
  }
}
