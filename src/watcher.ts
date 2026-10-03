import { log } from "./logger.js";
import {
  HttpError,
  PaperclipClient,
  WATCHER_RECOVERY_TITLE_PREFIX,
} from "./paperclip-client.js";
import type { IssueSummary, WatcherConfig } from "./types.js";

export function isMissingDisposition(issue: IssueSummary): boolean {
  return (
    issue.blockedInboxAttention?.state === "missing_disposition" ||
    issue.blockedInboxAttention?.reason === "missing_successful_run_disposition"
  );
}

export function isWatcherRecoveryIssue(issue: IssueSummary): boolean {
  return issue.title?.startsWith(WATCHER_RECOVERY_TITLE_PREFIX) === true;
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
      if (isWatcherRecoveryIssue(issue)) {
        log("warn", "Watcher recovery task itself is missing a disposition; nested escalation suppressed", {
          issueId: issue.id,
          identifier: issue.identifier ?? null,
          ceoAgentId: this.config.ceoAgentId,
        });
        continue;
      }

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
          log("info", "Dry run: would create CEO recovery task", {
            issueId: issue.id,
            identifier: issue.identifier ?? null,
            recoveryActionId: active.id,
          });
          continue;
        }

        const recoveryIssue = await this.client.createCeoRecoveryIssue({
          companyId,
          issue,
          recovery: active,
        });
        this.escalatedActionIds.add(active.id);

        if (recoveryIssue.deduplicated === true) {
          log("info", "CEO recovery task already exists", {
            issueId: issue.id,
            identifier: issue.identifier ?? null,
            recoveryActionId: active.id,
            recoveryIssueId: recoveryIssue.id,
            recoveryIssueIdentifier: recoveryIssue.identifier ?? null,
            deduplicationReason: recoveryIssue.deduplicationReason ?? null,
          });
          continue;
        }

        escalated += 1;
        log("info", "Created CEO recovery task for missing disposition", {
          issueId: issue.id,
          identifier: issue.identifier ?? null,
          recoveryActionId: active.id,
          recoveryIssueId: recoveryIssue.id,
          recoveryIssueIdentifier: recoveryIssue.identifier ?? null,
          ceoAgentId: this.config.ceoAgentId,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          log("warn", "Failed to create CEO recovery task; will retry on a later poll", {
            issueId: issue.id,
            identifier: issue.identifier ?? null,
            status: error.status,
            responseBody: error.body.slice(0, 1000),
          });
        } else {
          log("warn", "Failed to create CEO recovery task; will retry on a later poll", {
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
