import type { AgentSummary, IssueSummary, HeartbeatRunSummary, WakeupResponse, WatcherConfig } from "./types.js";
export type FetchLike = typeof fetch;
export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message); this.name = "HttpError";
  }
}
export class PaperclipClient {
  constructor(private readonly config: WatcherConfig, private readonly fetchImpl: FetchLike = fetch) {}
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(this.config.apiUrl + path, {
      ...init, signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      headers: {Authorization: "Bearer " + this.config.apiKey, Accept: "application/json",
        ...(init.body ? {"Content-Type":"application/json"} : {}), ...init.headers},
    });
    const text = await response.text();
    if (!response.ok) throw new HttpError("Paperclip " + path + " returned " + response.status, response.status, text);
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
  getAgent(agentId: string): Promise<AgentSummary> {
    return this.request("/api/agents/" + encodeURIComponent(agentId));
  }
  async listAssignedIssues(companyId: string, agentId: string): Promise<IssueSummary[]> {
    const all: IssueSummary[] = [], seen = new Set<string>();
    let afterId: string | null = null;
    for (let n=0;n<1000;n++) {
      const query = new URLSearchParams({assigneeAgentId:agentId,limit:String(this.config.pageSize),
        sortField:"id",sortDir:"asc"});
      if (afterId) query.set("afterId", afterId);
      const page = await this.request<IssueSummary[]>("/api/companies/"+encodeURIComponent(companyId)+"/issues?"+query);
      if (!Array.isArray(page)) throw new Error("Invalid issues response");
      for (const issue of page) {
        if (!issue || !issue.id || issue.assigneeAgentId !== agentId || seen.has(issue.id))
          throw new Error("Incomplete/repeated CTO issue response");
        seen.add(issue.id); all.push(issue);
      }
      if (page.length < this.config.pageSize) return all;
      const next = page.at(-1)?.id;
      if (!next || next === afterId) throw new Error("Issue pagination stalled");
      afterId = next;
    }
    throw new Error("Issue pagination safety cap");
  }
  async listAgentRuns(companyId: string, agentId: string): Promise<HeartbeatRunSummary[]> {
    const query = new URLSearchParams({agentId,limit:"200"});
    const runs = await this.request<HeartbeatRunSummary[]>("/api/companies/"+encodeURIComponent(companyId)+"/heartbeat-runs?"+query);
    if (!Array.isArray(runs) || runs.some(r => !r || r.agentId !== agentId || !r.status))
      throw new Error("Invalid CTO runs response");
    return runs;
  }
  wakeCto(agentId: string, key: string): Promise<WakeupResponse> {
    return this.request("/api/agents/"+encodeURIComponent(agentId)+"/wakeup", {
      method:"POST",body:JSON.stringify({source:"automation",triggerDetail:"system",
        reason:"cto_idle_after_tasks_closed",idempotencyKey:key}),
    });
  }
}
