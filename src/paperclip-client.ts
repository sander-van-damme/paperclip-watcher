import type {
  AgentSummary,
  IssueSummary,
  RecoveryActionsResponse,
  WakeupResponse,
  WatcherConfig,
} from "./types.js";

export type FetchLike = typeof fetch;

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
    let afterId: string | undefined;

    for (;;) {
      const params = new URLSearchParams({
        attention: "blocked",
        includeBlockedInboxAttention: "true",
        limit: String(this.config.pageSize),
        sortField: "id",
        sortDir: "asc",
      });
      if (afterId) params.set("afterId", afterId);

      const page = await this.request<IssueSummary[]>(
        `/api/companies/${encodeURIComponent(companyId)}/issues?${params.toString()}`,
      );
      all.push(...page);

      if (page.length < this.config.pageSize) break;
      const last = page.at(-1);
      if (!last?.id || last.id === afterId) break;
      afterId = last.id;
    }

    return all;
  }

  getRecoveryActions(issueId: string): Promise<RecoveryActionsResponse> {
    return this.request<RecoveryActionsResponse>(
      `/api/issues/${encodeURIComponent(issueId)}/recovery-actions`,
    );
  }

  wakeCeo(input: {
    issue: IssueSummary;
    recoveryActionId: string;
  }): Promise<WakeupResponse> {
    const issueLabel = input.issue.identifier ?? input.issue.id;
    return this.request<WakeupResponse>(`/api/agents/${encodeURIComponent(this.config.ceoAgentId)}/wakeup`, {
      method: "POST",
      body: JSON.stringify({
        source: "automation",
        triggerDetail: "system",
        reason: "missing_disposition_escalation",
        payload: {
          issueId: input.issue.id,
          issueIdentifier: input.issue.identifier ?? null,
          recoveryActionId: input.recoveryActionId,
          recoveryKind: "missing_disposition",
          watcher: "paperclip-watcher",
          instruction: `Paperclip detected a missing disposition for ${issueLabel}. Inspect the source issue and recovery evidence, determine the correct disposition, and resolve the recovery without taking ownership of the source task unless that is an explicit decision.`,
        },
        idempotencyKey: `paperclip-watcher:missing-disposition:${input.recoveryActionId}`,
      }),
    });
  }
}
