import type {
  AgentSummary,
  CreatedIssueResponse,
  IssueSummary,
  RecoveryAction,
  RecoveryActionsResponse,
  WatcherConfig,
} from "./types.js";

export type FetchLike = typeof fetch;

export const WATCHER_RECOVERY_TITLE_PREFIX = "[Paperclip Watcher Recovery]";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class PaperclipClient {
  constructor(
    private readonly config: WatcherConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const signal = AbortSignal.timeout(this.config.requestTimeoutMs);
    const response = await this.fetchImpl(`${this.config.apiUrl}${path}`, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });

    const text = await response.text();
    if (!response.ok) {
      throw new HttpError(
        `Paperclip ${init.method ?? "GET"} ${path} failed with HTTP ${response.status}`,
        response.status,
        text,
      );
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`Paperclip returned non-JSON for ${path}`);
    }
  }

  getAgent(agentId: string): Promise<AgentSummary> {
    return this.request<AgentSummary>(`/api/agents/${encodeURIComponent(agentId)}`);
  }

  async listBlockedIssues(companyId: string): Promise<IssueSummary[]> {
    const all: IssueSummary[] = [];
    let offset = 0;

    for (;;) {
      // Paperclip's blocked-attention list explicitly rejects ID ordering and
      // afterId cursors. It uses canonical activity ordering and offset paging.
      const params = new URLSearchParams({
        attention: "blocked",
        limit: String(this.config.pageSize),
        offset: String(offset),
      });

      const page = await this.request<IssueSummary[]>(
        `/api/companies/${encodeURIComponent(companyId)}/issues?${params.toString()}`,
      );
      all.push(...page);

      if (page.length < this.config.pageSize) break;
      offset += page.length;
    }

    return all;
  }

  getRecoveryActions(issueId: string): Promise<RecoveryActionsResponse> {
    return this.request<RecoveryActionsResponse>(
      `/api/issues/${encodeURIComponent(issueId)}/recovery-actions`,
    );
  }

  createCeoRecoveryIssue(input: {
    companyId: string;
    issue: IssueSummary;
    recovery: RecoveryAction;
  }): Promise<CreatedIssueResponse> {
    const issueLabel = input.issue.identifier ?? input.issue.id;
    const evidence = input.recovery.evidence ?? {};
    const failureSummary =
      typeof evidence.failureSummary === "string" ? evidence.failureSummary.trim() : "";

    const description = [
      "Paperclip detected that a task run ended without a valid final disposition.",
      "",
      `Source issue: ${issueLabel}`,
      `Source issue ID: ${input.issue.id}`,
      ...(input.issue.title ? [`Source title: ${input.issue.title}`] : []),
      `Source status: ${input.issue.status ?? "unknown"}`,
      `Source assignee agent ID: ${input.issue.assigneeAgentId ?? "unassigned"}`,
      `Recovery action ID: ${input.recovery.id}`,
      `Recovery kind: ${input.recovery.kind}`,
      ...(input.recovery.cause ? [`Recovery cause: ${input.recovery.cause}`] : []),
      ...(failureSummary ? [`Failure summary: ${failureSummary}`] : []),
      ...(input.recovery.nextAction ? [`Paperclip next action: ${input.recovery.nextAction}`] : []),
      "",
      "CEO recovery instructions:",
      "1. Re-read the source issue and its current recovery action before acting. If this recovery is already stale/resolved, do not change the source issue.",
      "2. Inspect the source task, run result, comments, and recovery evidence and determine the correct source disposition.",
      "3. Resolve the active source recovery and apply the appropriate source status using Paperclip's normal control-plane tools.",
      "4. Do not take ownership of the source task merely to perform this recovery. Preserve its existing assignee unless reassignment is an explicit recovery decision.",
      "5. When the source recovery has been handled, mark this recovery task done.",
    ].join("\n");

    return this.request<CreatedIssueResponse>(
      `/api/companies/${encodeURIComponent(input.companyId)}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: `${WATCHER_RECOVERY_TITLE_PREFIX} ${issueLabel}: missing disposition`,
          description,
          status: "todo",
          priority: "high",
          assigneeAgentId: this.config.ceoAgentId,
          idempotencyKey: `paperclip-watcher:missing-disposition:${input.recovery.id}`,
          allowDuplicate: true,
        }),
      },
    );
  }
}
