export type AgentProviderType = 'claude' | 'codex' | 'gemini' | 'opencode';

export type AgentState =
  | 'running'
  | 'waiting_approval'
  | 'waiting_input'
  | 'finished'
  | 'error'
  | 'idle';

export type AgentEventType =
  | 'discovered'
  | 'started'
  | 'tool_started'
  | 'tool_finished'
  | 'approval_requested'
  | 'input_requested'
  | 'finished'
  | 'error'
  | 'heartbeat';

export interface AgentInstance {
  id: string;
  provider: AgentProviderType;
  providerInstanceId: string;
  name: string;
  cwd?: string;
  pid?: number;
  startedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalRequest {
  id: string;
  agentId: string;
  provider: AgentProviderType;
  toolName: string;
  summary: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  payload: unknown;
  createdAt: string;
  resolvedAt?: string;
}

export interface AgentStatus extends AgentInstance {
  status: AgentState;
  task?: string;
  currentTool?: string;
  waitingFor?: string;
  lastResult?: string;
  activeSince?: string;
  updatedAt: string;
  finishedAt?: string;
  approval?: ApprovalRequest;
}

export interface AgentEvent {
  id?: number;
  agentId: string;
  provider: AgentProviderType;
  providerInstanceId: string;
  type: AgentEventType;
  ts: string;
  payload: unknown;
}

export interface TaskHistory {
  id: number;
  agentId: string;
  provider: AgentProviderType;
  providerInstanceId?: string;
  task?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  finalStatus: AgentState;
  resultSummary?: string;
}

export interface DashboardStats {
  todayFinished: number;
  todayError: number;
}

export interface DashboardSnapshot {
  agents: AgentStatus[];
  approvals: ApprovalRequest[];
  history: TaskHistory[];
  historyTotal: number;
  stats: DashboardStats;
  updatedAt: string;
}

export type WsMessage =
  | { type: 'snapshot'; payload: DashboardSnapshot }
  | { type: 'agent'; payload: AgentStatus }
  | { type: 'approval'; payload: ApprovalRequest }
  | { type: 'history'; payload: TaskHistory }
  | { type: 'error'; payload: { message: string } };
