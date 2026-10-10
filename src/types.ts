export interface AgentSummary { id: string; companyId: string; name?: string | null; status: string; }
export interface IssueSummary {
  id: string; identifier?: string | null; status: string;
  assigneeAgentId?: string | null; completedAt?: string | null; cancelledAt?: string | null;
}
export interface HeartbeatRunSummary {
  id: string; agentId: string; status: string; livenessState?: string | null;
}
export interface WakeupResponse { id?: string; status: string; reason?: string | null; }
export interface WatcherState { lastHandledSignature: string | null; lastWakeAt: number | null; }
export interface WatcherConfig {
  apiUrl: string; apiKey: string; ctoAgentId: string; companyId?: string;
  pollIntervalMs: number; requestTimeoutMs: number; pageSize: number;
  idleGraceMs: number; cooldownMs: number; stateDir: string; dryRun: boolean;
}
