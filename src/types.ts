export interface AgentSummary { id: string; companyId: string; name?: string | null; role?: string; status: string; }
export interface IssueReviewAttentionPath {
  kind: string;
  ref: string | null;
}
export interface IssueReviewAttention {
  state: string;
  paths: IssueReviewAttentionPath[];
}
export interface IssueExecutionState {
  status: string;
  currentParticipant: {type: string; userId?: string | null; agentId?: string | null} | null;
}
export interface IssueInteractionSummary {
  id: string;
  status: string;
  effectiveResolverPolicy?: string | null;
  addresseeUserId?: string | null;
  addresseeAgentId?: string | null;
}
export interface IssueSummary {
  id: string; identifier?: string | null; title?: string | null; status: string;
  assigneeAgentId?: string | null; assigneeUserId?: string | null;
  parentId?: string | null; originKind?: string | null;
  companyId?: string; completedAt?: string | null; cancelledAt?: string | null;
  reviewAttention?: IssueReviewAttention | null;
  executionState?: IssueExecutionState | null;
  blockedInboxAttention?: {
    state: string;
    reason: string;
    owner?: { type: string } | null;
  } | null;
  scheduledRetry?: { status: string } | null;
  activeRun?: { status: string } | null;
  activeRecoveryAction?: { status: string } | null;
}
export interface IssueRunSummary {
  runId: string;
  agentId: string;
  status: string;
  errorCode?: string | null;
  createdAt: string;
  scheduledRetryAt?: string | null;
}
export interface HeartbeatRunSummary {
  id: string; agentId: string; status: string; livenessState?: string | null; errorCode?: string | null; contextSnapshot?: { issueId?: string | null } | null;
}
export interface WakeupResponse { id?: string; status: string; reason?: string | null; }
export interface TaskWatchdogSummary {
  id: string;
  issueId: string;
  watchdogAgentId: string;
  status: string;
}
export interface WatcherState { lastHandledSignature: string | null; lastWakeAt: number | null; }
export interface PushoverConfig { token: string; user: string; baseUrl: string; userId?: string; }
export interface CodexQuotaConfig {
  executable: string;
  intervalMs: number;
  expectedAccountId?: string;
}
export interface WatcherConfig {
  apiUrl: string; apiKey: string; ctoAgentId: string; companyId?: string;
  pollIntervalMs: number; requestTimeoutMs: number; pageSize: number;
  idleGraceMs: number; cooldownMs: number; stateDir: string; dryRun: boolean;
  ceoAgentId?: string;
  taskWatchdogScanIntervalMs: number;
  taskWatchdogMaxAttachmentsPerPoll: number;
  taskWatchdogInstructions: string;
  pushover?: PushoverConfig;
  codexQuota?: CodexQuotaConfig;
}
