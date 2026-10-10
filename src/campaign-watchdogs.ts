import { log } from "./logger.js";
import { PaperclipClient } from "./paperclip-client.js";
import type { WatcherConfig, IssueSummary, AgentSummary } from "./types.js";
import type { CampaignWatchdogStore } from "./campaign-state.js";

const NONTERMINAL = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const MAX_PARENT_DEPTH = 100;

export interface CampaignWatchdogPollResult {
  candidates: number;
  eligible: number;
  alreadyConfigured: number;
  attached: number;
  dryRunCandidates: number;
  skippedKnown: number;
  coveredByAncestor: number;
  deferredByLimit: number;
}

/**
 * Protect every open CTO task, without creating a second watchdog for its
 * children. The Paperclip task watchdog itself owns stopped-subtree detection,
 * recovery tasks, run/queue checks and idempotency.
 *
 * This external service ONLY opts task roots in. It never edits dependencies,
 * manually wakes the CEO, or changes issue statuses.
 */
export class CampaignWatchdogSupervisor {
  private known: Set<string> | null = null;

  constructor(
    private readonly config: WatcherConfig,
    private readonly client: PaperclipClient,
    private readonly store: CampaignWatchdogStore,
  ) {}

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

  async pollOnce(): Promise<CampaignWatchdogPollResult> {
    if (!this.config.taskWatchdogEnabled) {
      throw new Error("Task watchdog supervisor is disabled");
    }
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
    if (!["idle", "active"].includes(cto.status) || !["idle", "active"].includes(ceo.status)) {
      throw new Error("CTO or CEO cannot currently run; skip watchdog attachment");
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
        // An active CTO ancestor will itself be covered as a root. Do not
        // attach separate watchdogs to its descendant tasks.
        if (parent.assigneeAgentId === cto.id && NONTERMINAL.has(parent.status)) return true;
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
      return NONTERMINAL.has(issue.status) && issue.originKind !== "task_watchdog";
    });
    const result: CampaignWatchdogPollResult = {
      candidates: candidates.length,
      eligible: 0,
      alreadyConfigured: 0,
      attached: 0,
      dryRunCandidates: 0,
      skippedKnown: 0,
      coveredByAncestor: 0,
      deferredByLimit: 0,
    };

    for (const issue of candidates) {
      if (await coveredByParent(issue)) {
        result.coveredByAncestor += 1;
        continue;
      }
      if (this.known.has(issue.id)) {
        result.skippedKnown += 1;
        continue;
      }
      result.eligible += 1;
      if (!this.config.dryRun && result.attached >= this.config.taskWatchdogMaxAttachmentsPerPoll) {
        // Complete the coverage scan for accurate counters without exceeding
        // the cap on new watchdogs (or generating extra API writes).
        result.deferredByLimit += 1;
        continue;
      }
      const existing = await this.client.getTaskWatchdog(issue.id);
      if (existing !== null) {
        // Never overwrite a manually configured watchdog or instructions.
        await this.remember(issue.id);
        result.alreadyConfigured += 1;
        continue;
      }
      if (this.config.dryRun) {
        result.dryRunCandidates += 1;
        continue;
      }

      // Paperclip's API provides an upsert rather than an atomic
      // create-only endpoint. Double-check before PUT to reduce, but not
      // eliminate, the concurrent human configuration race.
      const rechecked = await this.client.getTaskWatchdog(issue.id);
      if (rechecked !== null) {
        await this.remember(issue.id);
        result.alreadyConfigured += 1;
        continue;
      }
      const installed = await this.client.putTaskWatchdog(
        issue.id, ceo.id, this.config.taskWatchdogInstructions,
      );
      if (installed.issueId !== issue.id ||
          installed.watchdogAgentId !== ceo.id ||
          installed.status !== "active") {
        throw new Error("Unexpected Paperclip watchdog response for " + issue.id);
      }
      await this.remember(issue.id);
      result.attached += 1;
      log("info", "CEO task watchdog attached", {
        issue: issue.identifier ?? issue.id,
        ceoAgentId: ceo.id,
      });
      // Other potential tasks are still inspected for coverage, but deferred
      // until a later scan once the attachment limit has been reached.
    }
    return result;
  }
}
