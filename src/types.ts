export interface AgentSummary {
  id: string;
  companyId: string;
  name?: string | null;
}

export interface BlockedInboxAttention {
  kind?: string;
  state?: string;
  reason?: string;
}

export interface IssueSummary {
  id: string;
  identifier?: string | null;
  title?: string | null;
  status?: string | null;
  assigneeAgentId?: string | null;
  blockedInboxAttention?: BlockedInboxAttention | null;
}

export interface RecoveryAction {
  id: string;
  kind: string;
  status?: string | null;
  ownerType?: string | null;
  ownerAgentId?: string | null;
  sourceIssueId?: string | null;
  cause?: string | null;
  nextAction?: string | null;
  evidence?: Record<string, unknown> | null;
}

export interface RecoveryActionsResponse {
  active?: RecoveryAction | null;
  actions?: RecoveryAction[];
}

export interface CreatedIssueResponse {
  id: string;
  identifier?: string | null;
  title?: string | null;
  deduplicated?: boolean;
  deduplicationReason?: string | null;
}

export interface WatcherConfig {
  apiUrl: string;
  apiKey: string;
  ceoAgentId: string;
  companyId?: string;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  pageSize: number;
  dryRun: boolean;
}
