import { createHash } from "node:crypto";
import { log } from "./logger.js";
import { PaperclipClient } from "./paperclip-client.js";
import type { IssueSummary, WatcherConfig, WatcherState } from "./types.js";
import type { StateStore } from "./state.js";

const TERMINAL = new Set(["done", "cancelled"]);
const WORK = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const ACTIVE_RUNS = new Set(["queued", "running", "scheduled_retry"]);
const FAILURE_RUNS = new Set(["failed", "interrupted", "timed_out", "cancelled"]);

function signature(issues: IssueSummary[]): string {
  return createHash("sha256").update(JSON.stringify(issues.map(issue => [
    issue.id, issue.status, issue.completedAt ?? null, issue.cancelledAt ?? null,
  ]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))).digest("hex");
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

  async pollOnce(): Promise<{ state: string; count: number }> {
    const companyId = await this.company();
    const agent = await this.client.getAgent(this.config.ctoAgentId);
    if (agent.companyId !== companyId) throw new Error("CTO company mismatch");
    if (!["active", "idle"].includes(agent.status)) return this.reset("agent_unavailable");
    const issues = await this.client.listAssignedIssues(companyId, this.config.ctoAgentId);
    if (issues.some(issue => !TERMINAL.has(issue.status) && !WORK.has(issue.status))) {
      return this.reset("unknown_issue_status");
    }
    if (issues.some(issue => WORK.has(issue.status))) {
      // Track the nonterminal state so the subsequent terminal transition triggers a wake.
      if (this.state === null) this.state = await this.stateStore.load();
      const current = signature(issues);
      if (this.state.lastHandledSignature !== current) {
        this.state.lastHandledSignature = current;
        await this.stateStore.save(this.state);
      }
      return this.reset("outstanding_issues", issues.length);
    }
    if (issues.length === 0) return this.reset("no_assigned_issues");
    const runs = await this.client.listAgentRuns(companyId, this.config.ctoAgentId);
    if (runs.some(run => ACTIVE_RUNS.has(run.status))) return this.reset("active_or_retrying_run", issues.length);
    if (runs.some(run => !ACTIVE_RUNS.has(run.status) && !["succeeded", ...FAILURE_RUNS].includes(run.status))) {
      return this.reset("unknown_run_status");
    }
    const mostRecent = runs[0];
    if (!mostRecent || mostRecent.status !== "succeeded" || mostRecent.livenessState === "blocked") {
      return this.reset("last_run_not_successful", issues.length);
    }

    const sig = signature(issues);
    if (this.state === null) this.state = await this.stateStore.load();
    // An existing terminal snapshot is eligible on first installation too.
    // Older versions mistakenly saved that snapshot as handled without
    // invoking a wake. lastWakeAt=null distinguishes that legacy baseline
    // from a snapshot for which a wake was actually requested.
    if (this.state.lastHandledSignature === sig && this.state.lastWakeAt !== null) {
      return this.reset("already_handled", issues.length);
    }
    if (this.lastObservedSignature !== sig) {
      this.lastObservedSignature = sig;
      this.emptySince = this.now();
      return { state: "settling", count: issues.length };
    }
    if (this.emptySince === null) this.emptySince = this.now();
    if (this.now() - this.emptySince < this.config.idleGraceMs) return { state: "settling", count: issues.length };
    if (this.state.lastWakeAt !== null && this.now() - this.state.lastWakeAt < this.config.cooldownMs) {
      return { state: "cooldown", count: issues.length };
    }

    // Persist *before* invoking. An uncertain network response must not
    // cause repeated wakes. Operators can manually reset the state file.
    this.state.lastHandledSignature = sig;
    this.state.lastWakeAt = this.now();
    if (!this.config.dryRun) {
      await this.stateStore.save(this.state);
      const result = await this.client.wakeCto(this.config.ctoAgentId, "paperclip-watcher:idle:" + sig);
      log("info", "CTO wake requested", { resultStatus: result.status });
    }
    this.emptySince = null;
    return { state: this.config.dryRun ? "dry_run" : "woken", count: issues.length };
  }

  private reset(state: string, count = 0): { state: string; count: number } {
    this.emptySince = null;
    this.lastObservedSignature = null;
    return { state, count };
  }
}
