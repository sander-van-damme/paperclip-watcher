import { log } from "./logger.js";
import { HttpError, PaperclipClient } from "./paperclip-client.js";
import type { IssueSummary, WatcherConfig } from "./types.js";

export function isMissingDisposition(issue: IssueSummary): boolean {
  return (
    issue.blockedInboxAttention?.state === "missing_disposition" ||
    issue.blockedInboxAttention?.reason === "missing_successful_run_disposition"
  );
}

export class PaperclipWatcher {
  private companyId: string | undefined;
  private readonly escalatedActionIds = new Set<string>();

  constructor(
    private readonly config: WatcherConfig,
    private readonly client: PaperclipClient,
  ) {
    this.companyId = config.companyId;
  }

  private async resolveCompanyId(): Promise<string> {
    if (this.companyId) return this.companyId;
    const ceo = await this.client.getAgent(this.config.ceoAgentId);
    if (!ceo.companyId) throw new Error("CEO agent response did not include companyId");
    this.companyId = ceo.companyId;
    log("info", "Derived company from CEO agent", {
      companyId: ceo.companyId,
      ceoAgentId: this.config.ceoAgentId,
      ceoName: ceo.name ?? null,
    });
    return ceo.companyId;
  }

  async pollOnce(): Promise<{ scanned: number; candidates: number; escalated: number }> {
    const companyId = await this.resolveCompanyId();
    const issues = await this.client.listBlockedIssues(companyId);
    const candidates = issues.filter(isMissingDisposition);
    let escalated = 0;
    const activeActionIds = new Set<string>();

    for (const issue of candidates) {
      try {
        const recovery = await this.client.getRecoveryActions(issue.id);
        const active = recovery.active;
        if (!active || active.kind !== "missing_disposition") {
          log("info", "Skipped stale missing-disposition attention", {
            issueId: issue.id,
            identifier: issue.identifier ?? null,
            activeRecoveryKind: active?.kind ?? null,
          });
          continue;
        }
        activeActionIds.add(active.id);

        if (this.escalatedActionIds.has(active.id)) {
          continue;
        }

        if (this.config.dryRun) {
          log("info", "Dry run: would wake CEO for missing disposition", {
            issueId: issue.id,
            identifier: issue.identifier ?? null,
            recoveryActionId: active.id,
          });
          continue;
        }

        const wake = await this.client.wakeCeo({ issue, recoveryActionId: active.id });
        if (wake?.status === "skipped") {
          log("warn", "CEO wakeup was skipped; will retry on a later poll", {
            issueId: issue.id,
            identifier: issue.identifier ?? null,
            recoveryActionId: active.id,
            reason: wake.reason ?? null,
            message: wake.message ?? null,
          });
          continue;
        }
        this.escalatedActionIds.add(active.id);
        escalated += 1;
        log("info", "Escalated missing disposition to CEO", {
          issueId: issue.id,
          identifier: issue.identifier ?? null,
          recoveryActionId: active.id,
          ceoAgentId: this.config.ceoAgentId,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          log("warn", "Failed to escalate one issue; will retry on a later poll", {
            issueId: issue.id,
            identifier: issue.identifier ?? null,
            status: error.status,
            responseBody: error.body.slice(0, 1000),
          });
        } else {
          log("warn", "Failed to escalate one issue; will retry on a later poll", {
            issueId: issue.id,
            identifier: issue.identifier ?? null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    for (const actionId of this.escalatedActionIds) {
      if (!activeActionIds.has(actionId)) this.escalatedActionIds.delete(actionId);
    }

    return { scanned: issues.length, candidates: candidates.length, escalated };
  }
}
