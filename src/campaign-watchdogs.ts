import { log } from "./logger.js";
import { PaperclipClient } from "./paperclip-client.js";
import type { WatcherConfig, IssueSummary } from "./types.js";
import type { CampaignWatchdogStore } from "./campaign-state.js";

const NONTERMINAL = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

export interface CampaignWatchdogPollResult {
  candidates: number;
  eligible: number;
  alreadyConfigured: number;
  attached: number;
  dryRunCandidates: number;
  skippedKnown: number;
}

/**
 * Only attach Paperclip's native task watchdog to CTO-owned, nonterminal
 * root issues that have actual child issues. Do not attempt to fix issues,
 * touch dependency edges, or wake the CEO ourselves.
 */
export class CampaignWatchdogSupervisor {
  private known: Set<string> | null = null;

  constructor(
    private readonly config: WatcherConfig,
    private readonly client: PaperclipClient,
    private readonly store: CampaignWatchdogStore,
  ) {}

  private async remember(issueId: string): Promise<void> {
    if (!this.known) throw new Error("Campaign watchdog state not loaded");
    if (this.known.has(issueId)) return;
    // Save before treating as handled. A failed state write is an error
    // and must not lose the "do not reattach" protection on restart.
    await this.store.save([...this.known, issueId]);
    this.known.add(issueId);
  }

  async pollOnce(): Promise<CampaignWatchdogPollResult> {
    if (!this.config.taskWatchdogEnabled || !this.config.ceoAgentId) {
      throw new Error("Campaign task watchdog supervisor is not configured");
    }
    if (this.known === null) this.known = new Set(await this.store.load());

    const cto = await this.client.getAgent(this.config.ctoAgentId);
    const ceo = await this.client.getAgent(this.config.ceoAgentId);
    if (!cto.companyId || cto.companyId !== ceo.companyId ||
        (this.config.companyId && this.config.companyId !== cto.companyId)) {
      throw new Error("CTO / CEO company mismatch");
    }
    if (cto.role !== "cto" || ceo.role !== "ceo") {
      throw new Error("Configured agent IDs must identify the CTO and CEO roles");
    }
    if (!["active", "idle"].includes(cto.status) || !["active", "idle"].includes(ceo.status)) {
      throw new Error("CTO or CEO is not invokable; no campaign watchdogs assigned");
    }

    // The CTO assignment list is complete and cursor-paginated. A root that
    // has only children owned by other agents is still found by the per-parent
    // child lookup below. Never use a hardcoded campaign title/prefix.
    const assigned = await this.client.listAssignedIssues(cto.companyId, cto.id);
    const roots = assigned.filter(issue =>
      issue.parentId === null &&
      NONTERMINAL.has(issue.status) &&
      issue.originKind !== "task_watchdog"
    );
    const result: CampaignWatchdogPollResult = {
      candidates: roots.length,
      eligible: 0,
      alreadyConfigured: 0,
      attached: 0,
      dryRunCandidates: 0,
      skippedKnown: 0,
    };

    for (const root of roots) {
      if (this.known.has(root.id)) {
        result.skippedKnown += 1;
        continue;
      }
      if (!(await this.client.hasOrdinaryChildIssue(cto.companyId, root.id))) continue;
      result.eligible += 1;
      const existing = await this.client.getTaskWatchdog(root.id);
      if (existing !== null) {
        // Preserve another agent's watchdog and even its custom instructions.
        await this.remember(root.id);
        result.alreadyConfigured += 1;
        continue;
      }
      if (this.config.dryRun) {
        result.dryRunCandidates += 1;
        log("info", "Campaign watchdog dry run", { issue: root.identifier ?? root.id, ceoAgentId: ceo.id });
        continue;
      }

      // Paperclip exposes an upsert, not an atomic create-if-absent.
      // Re-read immediately before PUT to reduce the small concurrent-operator
      // race window. Never deliberately overwrite an existing configuration.
      const rechecked = await this.client.getTaskWatchdog(root.id);
      if (rechecked !== null) {
        await this.remember(root.id);
        result.alreadyConfigured += 1;
        continue;
      }

      const installed = await this.client.putTaskWatchdog(root.id, ceo.id, this.config.taskWatchdogInstructions);
      if (installed.issueId !== root.id || installed.watchdogAgentId !== ceo.id || installed.status !== "active") {
        throw new Error("Paperclip returned an unexpected watchdog configuration for " + root.id);
      }
      await this.remember(root.id);
      result.attached += 1;
      log("info", "CEO task watchdog attached", { issue: root.identifier ?? root.id, watchdogAgentId: ceo.id });

      if (result.attached >= this.config.taskWatchdogMaxAttachmentsPerPoll) break;
    }
    return result;
  }
}
