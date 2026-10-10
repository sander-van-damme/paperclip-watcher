export interface AgentSummary { id: string; companyId: string; name?: string | null; role?: string; status: string; }
export interface IssueSummary {
  id: string; identifier?: string | null; title?: string | null; status: string;
  assigneeAgentId?: string | null; parentId?: string | null; originKind?: string | null;
  companyId?: string; completedAt?: string | null; cancelledAt?: string | null;
}
export interface HeartbeatRunSummary {
  id: string; agentId: string; status: string; livenessState?: string | null;
}
export interface WakeupResponse { id?: string; status: string; reason?: string | null; }
export interface TaskWatchdogSummary {
  id: string;
  issueId: string;
  watchdogAgentId: string;
  status: string;
}
export interface WatcherState { lastHandledSignature: string | null; lastWakeAt: number | null; }
export interface WatcherConfig {
  apiUrl: string; apiKey: string; ctoAgentId: string; companyId?: string;
  pollIntervalMs: number; requestTimeoutMs: number; pageSize: number;
  idleGraceMs: number; cooldownMs: number; stateDir: string; dryRun: boolean;
  taskWatchdogEnabled: boolean;
  ceoAgentId?: string;
  taskWatchdogScanIntervalMs: number;
  taskWatchdogMaxAttachmentsPerPoll: number;
  taskWatchdogInstructions: string;
}
