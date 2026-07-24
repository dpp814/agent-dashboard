import type { AgentEvent, AgentStatus, ApprovalRequest, DashboardSnapshot, HistoryDetail, HistoryProviderFilter, TaskHistory } from '@agent-monitor/shared';
import { AppDatabase } from '../db/Database.js';
import { newId, stableId } from '../util/ids.js';
import { taskStartFromTranscriptFile } from '../util/claudeTranscript.js';

export class StateStore {
  private agents = new Map<string, AgentStatus>();
  private activeTasks = new Map<string, { startedAt: string; task?: string }>();
  private approvalWaiters = new Map<string, {
    resolve: (approval: ApprovalRequest | undefined) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(private db: AppDatabase) {
    const expiredAgentIds = new Set(db.expirePendingApprovals('claude', new Date().toISOString()));
    for (const agentId of db.expireInvalidPendingApprovals(new Date().toISOString())) expiredAgentIds.add(agentId);
    const pendingAgentIds = new Set(db.listApprovals().map((approval) => approval.agentId));
    for (const agent of db.listAgents()) {
      if ((expiredAgentIds.has(agent.id) || !pendingAgentIds.has(agent.id)) && agent.status === 'waiting_approval') {
        agent.status = 'idle';
        agent.currentTool = undefined;
        agent.waitingFor = undefined;
        agent.activeSince = undefined;
        agent.updatedAt = new Date().toISOString();
        db.upsertAgent(agent);
      }
      this.agents.set(agent.id, agent);
    }
  }

  upsertDiscovered(agent: AgentStatus): { agent: AgentStatus; changed: boolean } {
    const previous = this.agents.get(agent.id);
    const merged = {
      ...agent,
      startedAt: previous?.startedAt ?? agent.startedAt,
      task: agent.task ?? previous?.task,
      currentTool: agent.currentTool ?? previous?.currentTool,
      lastResult: previous?.lastResult,
      activeSince: agent.activeSince ?? previous?.activeSince,
      approval: previous?.approval
    };
    const changed = !previous || comparableAgent(previous) !== comparableAgent(merged);
    this.agents.set(agent.id, merged);
    if (changed) this.db.upsertAgent(merged);
    return { agent: merged, changed };
  }

  applyEvent(event: AgentEvent): { agent: AgentStatus; approval?: ApprovalRequest; completed?: boolean; history?: TaskHistory } {
    this.db.insertEvent(event);
    const current = this.ensureAgent(event);
    const agent = reduceAgent(current, event);
    this.agents.set(agent.id, agent);
    this.db.upsertAgent(agent);

    if (event.type === 'started') {
      const payload = event.payload as Record<string, unknown>;
      this.activeTasks.set(agent.id, {
        startedAt: event.ts,
        task: getTask(payload, event.ts) ?? agent.task
      });
    }

    let approval: ApprovalRequest | undefined;
    if (event.type === 'approval_requested') {
      approval = createApproval(agent, event);
      this.db.upsertApproval(approval);
      agent.approval = approval;
    }
    if ((event.provider === 'codex' || event.provider === 'grok') && event.type === 'tool_finished') {
      this.resolveMatchingProviderApproval(event, 'approved');
    }

    const completed = ['finished', 'error'].includes(event.type) &&
      !this.db.hasHistoryForCompletion(agent.id, event.ts) &&
      (isCompletingActiveAgent(current, this.activeTasks.has(agent.id)) || isCompletableCompletionEvent(event));
    let history: TaskHistory | undefined;
    if (completed) {
      const endedAt = event.ts;
      const payload = event.payload as Record<string, unknown>;
      const eventTask = getTask(payload, endedAt);
      const activeTask = this.activeTasks.get(agent.id) ??
        taskStartFromTranscript(payload, endedAt) ??
        this.db.findLatestTaskStart(agent.id, endedAt);
      const fallbackStartedAt = earlierIso(current.activeSince, current.startedAt) ?? endedAt;
      const activeStartedAt = activeTask?.startedAt ?? endedAt;
      const startedAt = activeStartedAt === endedAt ? fallbackStartedAt : activeStartedAt;
      history = this.db.insertHistory({
        agentId: agent.id,
        provider: agent.provider,
        providerInstanceId: agent.providerInstanceId,
        task: eventTask ?? activeTask?.task ?? agent.task,
        startedAt,
        endedAt,
        durationMs: durationMs(startedAt, endedAt),
        finalStatus: event.type === 'finished' ? 'finished' : agent.status,
        resultSummary: agent.lastResult
      });
      this.activeTasks.delete(agent.id);
    }

    return { agent, approval, completed, history };
  }

  snapshot(search = '', historyLimit = 50, historyOffset = 0, historyProvider: HistoryProviderFilter = 'all', historySessionId = ''): DashboardSnapshot {
    this.expireOldProviderApprovals();
    this.clearOrphanedApprovalAgents();
    const agents = [...this.agents.values()];
    return {
      agents: agents
        .filter((agent) => !isCodexPidDuplicate(agent, this.agents))
        .filter((agent) => isVisibleAgent(agent, this.agents))
        .map((agent) => toVisibleAgent(agent, this.agents))
        .map((agent, _, visibleAgents) => ({ ...agent, name: displayName(agent, visibleAgents) }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      approvals: this.db.listApprovals(),
      history: this.db.listHistory(search, historyProvider, historyLimit, historyOffset, historySessionId),
      historyTotal: this.db.countHistory(search, historyProvider, historySessionId),
      stats: this.db.countTodayHistory(...todayRange()),
      updatedAt: new Date().toISOString()
    };
  }

  historyDetail(id: number): HistoryDetail | undefined {
    const history = this.db.getHistory(id);
    return history ? { history, events: this.db.listEventsForHistory(history) } : undefined;
  }

  deleteHistory(id: number): { deletedHistory: number; deletedEvents: number } {
    return this.db.deleteHistory(id);
  }

  deleteHistorySession(sessionId: string): { deletedHistory: number; deletedEvents: number } {
    return this.db.deleteHistorySession(sessionId);
  }

  markProviderMissing(provider: AgentStatus['provider'], seenIds: Set<string>): AgentStatus[] {
    const now = new Date().toISOString();
    const changed: AgentStatus[] = [];
    for (const agent of this.agents.values()) {
      if (
        agent.provider !== provider ||
        seenIds.has(agent.id) ||
        ['finished', 'idle'].includes(agent.status) ||
        (agent.status === 'waiting_approval' && shouldKeepMissingApproval(agent, this.agents, seenIds))
      ) {
        continue;
      }
      const updated = {
        ...agent,
        status: 'idle' as const,
        updatedAt: now,
        currentTool: undefined,
        waitingFor: undefined,
        activeSince: undefined,
        metadata: { ...agent.metadata, discoveryMissing: true }
      };
      this.agents.set(agent.id, updated);
      this.db.upsertAgent(updated);
      if (agent.status === 'waiting_approval') this.expirePendingApprovalsForAgent(agent.id);
      this.activeTasks.delete(agent.id);
      changed.push(updated);
    }
    return changed;
  }

  waitForApproval(id: string, timeoutMs: number): Promise<ApprovalRequest | undefined> {
    return new Promise((resolve) => {
      if (!this.db.listApprovals().some((item) => item.id === id)) {
        resolve(undefined);
        return;
      }
      const timer = setTimeout(() => {
        resolve(this.resolveApproval(id, 'expired'));
      }, timeoutMs);
      this.approvalWaiters.set(id, { resolve, timer });
    });
  }

  resolveApproval(id: string, status: 'approved' | 'rejected' | 'expired'): ApprovalRequest | undefined {
    const approval = this.db.listApprovals().find((item) => item.id === id);
    if (!approval) return undefined;
    const resolved = { ...approval, status, resolvedAt: new Date().toISOString() };
    this.db.upsertApproval(resolved);
    const agent = this.agents.get(resolved.agentId);
    const hasPendingApproval = this.db.listApprovals().some((item) => item.agentId === resolved.agentId);
    if (agent?.approval?.id === resolved.id || (agent?.status === 'waiting_approval' && !hasPendingApproval)) {
      const updated = {
        ...agent,
        status: status === 'approved' ? 'running' as const : 'idle' as const,
        currentTool: undefined,
        waitingFor: undefined,
        activeSince: status === 'approved' ? agent.activeSince : undefined,
        approval: resolved,
        updatedAt: resolved.resolvedAt
      };
      this.agents.set(updated.id, updated);
      this.db.upsertAgent(updated);
    }
    const waiter = this.approvalWaiters.get(id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.approvalWaiters.delete(id);
      waiter.resolve(resolved);
    }
    return resolved;
  }

  private ensureAgent(event: AgentEvent): AgentStatus {
    const existing = this.agents.get(event.agentId);
    if (existing) return existing;
    const now = event.ts;
    return {
      id: event.agentId,
      provider: event.provider,
      providerInstanceId: event.providerInstanceId,
      name: `${event.provider} ${event.providerInstanceId.slice(0, 8)}`,
      status: 'idle',
      startedAt: now,
      updatedAt: now
    };
  }

  private resolveMatchingProviderApproval(event: AgentEvent, status: 'approved' | 'rejected' | 'expired'): void {
    const payload = event.payload as Record<string, unknown>;
    const toolName = getToolName(payload);
    const summary = summarizeApproval(payload);
    const approval = this.db.listApprovals()
      .filter((item) => item.provider === event.provider && item.agentId === event.agentId)
      .filter((item) => !toolName || item.toolName === toolName)
      .filter((item) => item.summary === summary)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (approval) this.resolveApproval(approval.id, status);
  }

  private expireOldProviderApprovals(): void {
    const cutoff = Date.now() - providerApprovalTtlMs();
    for (const approval of this.db.listApprovals()) {
      if ((approval.provider === 'codex' || approval.provider === 'grok') && Date.parse(approval.createdAt) < cutoff) {
        this.resolveApproval(approval.id, 'expired');
      }
    }
  }

  private clearOrphanedApprovalAgents(): void {
    const pendingAgentIds = new Set(this.db.listApprovals().map((approval) => approval.agentId));
    for (const agent of this.agents.values()) {
      if (agent.status !== 'waiting_approval' || pendingAgentIds.has(agent.id)) continue;
      const updated = {
        ...agent,
        status: 'idle' as const,
        currentTool: undefined,
        waitingFor: undefined,
        activeSince: undefined,
        approval: undefined,
        updatedAt: new Date().toISOString()
      };
      this.agents.set(updated.id, updated);
      this.db.upsertAgent(updated);
    }
  }

  private expirePendingApprovalsForAgent(agentId: string): void {
    for (const approval of this.db.listApprovals()) {
      if (approval.agentId === agentId) this.resolveApproval(approval.id, 'expired');
    }
  }
}

function providerApprovalTtlMs(): number {
  return Number(process.env.AGENT_MONITOR_CODEX_APPROVAL_TTL_MS ?? 2 * 60 * 1000);
}

function durationMs(startedAt: string, endedAt: string): number | undefined {
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function earlierIso(...values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => {
      if (!value) return false;
      return Number.isFinite(Date.parse(value));
    })
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}

function todayRange(): [string, string] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return [start.toISOString(), end.toISOString()];
}

function isVisibleAgent(agent: AgentStatus, agents?: Map<string, AgentStatus>): boolean {
  return isBaseVisibleAgent(agent);
}

function toVisibleAgent(agent: AgentStatus, agents: Map<string, AgentStatus>): AgentStatus {
  const codexSession = isCodexPidFallback(agent) ? latestCodexSessionForPid(agent, agents) : undefined;
  if (codexSession) {
    return {
      ...agent,
      task: codexSession.task ?? agent.task,
      currentTool: codexSession.status === 'running' ? codexSession.currentTool ?? agent.currentTool : agent.currentTool,
      waitingFor: codexSession.status === 'waiting_approval' || codexSession.status === 'waiting_input'
        ? codexSession.waitingFor ?? agent.waitingFor
        : agent.waitingFor,
      lastResult: codexSession.lastResult ?? agent.lastResult
    };
  }
  return agent;
}

function isBaseVisibleAgent(agent: AgentStatus): boolean {
  if (isStaleCodexSession(agent)) return false;
  return ['running', 'waiting_approval', 'waiting_input', 'error'].includes(agent.status);
}

function isStaleCodexSession(agent: AgentStatus): boolean {
  return isCodexSessionAgent(agent) &&
    agent.status === 'running' &&
    !agent.activeSince &&
    !agent.currentTool &&
    !agent.waitingFor;
}

function isCompletingActiveAgent(agent: AgentStatus, hasActiveTask: boolean): boolean {
  return hasActiveTask ||
    ['running', 'waiting_approval', 'waiting_input'].includes(agent.status) ||
    Boolean(agent.activeSince);
}

function isCompletableCompletionEvent(event: AgentEvent): boolean {
  if (event.provider !== 'claude' && event.provider !== 'codex' && event.provider !== 'grok') return false;
  const payload = event.payload as Record<string, unknown>;
  return Boolean(
    getTask(payload, event.ts) ||
    payload.transcript_path ||
    payload.transcriptPath ||
    payload.last_assistant_message ||
    payload.lastAssistantMessage ||
    payload.result ||
    payload.error ||
    payload.message
  );
}

function shouldKeepMissingApproval(agent: AgentStatus, agents: Map<string, AgentStatus>, seenIds: Set<string>): boolean {
  if (agent.provider !== 'codex' || !agent.cwd) return false;
  return [...agents.values()].some((candidate) =>
    candidate.id !== agent.id &&
    candidate.provider === agent.provider &&
    candidate.status === 'running' &&
    seenIds.has(candidate.id) &&
    pathsOverlap(normalizedPath(agent.cwd), normalizedPath(candidate.cwd))
  );
}

function isCodexPidDuplicate(agent: AgentStatus, agents: Map<string, AgentStatus>): boolean {
  if (!isCodexPidFallback(agent)) return false;
  const agentPid = Number(agent.providerInstanceId);
  const explicitDuplicate = [...agents.values()].some((candidate) => {
    if (candidate.provider !== 'codex' || candidate.id === agent.id || candidate.providerInstanceId === agent.providerInstanceId) {
      return false;
    }
    const pids = candidate.metadata?.pids;
    return Array.isArray(pids) && pids.some((pid) => Number(pid) === agentPid);
  });
  return explicitDuplicate || hiddenCodexPidsForWorkspace(agent, agents).some((candidate) => candidate.id === agent.id);
}

function hiddenCodexPidsForWorkspace(agent: AgentStatus, agents: Map<string, AgentStatus>): AgentStatus[] {
  const livePids = liveCodexPidsForWorkspace(agent, agents);
  const replacingSessions = visibleCodexSessionsForWorkspace(agent, agents);
  return livePids.slice(0, Math.min(livePids.length, replacingSessions.length));
}

function visibleCodexSessionsForWorkspace(agent: AgentStatus, agents: Map<string, AgentStatus>): AgentStatus[] {
  return [...agents.values()]
    .filter(isCodexSessionAgent)
    .filter(isBaseVisibleAgent)
    .filter((candidate) => isSameCodexWorkspace(agent, candidate))
    .sort(recentAgentFirst);
}

function liveCodexPidsForWorkspace(agent: AgentStatus, agents: Map<string, AgentStatus>): AgentStatus[] {
  return [...agents.values()]
    .filter(isCodexPidFallback)
    .filter((candidate) => candidate.status === 'running')
    .filter((candidate) => isSameCodexWorkspace(agent, candidate))
    .sort((a, b) => Number(a.providerInstanceId) - Number(b.providerInstanceId));
}

function latestCodexSessionForPid(agent: AgentStatus, agents: Map<string, AgentStatus>): AgentStatus | undefined {
  return [...agents.values()]
    .filter(isCodexSessionAgent)
    .filter((candidate) => Boolean(candidate.task))
    .filter((candidate) => isSameCodexWorkspace(agent, candidate))
    .filter((candidate) => !agent.startedAt || !candidate.startedAt || Date.parse(candidate.startedAt) >= Date.parse(agent.startedAt))
    .sort(recentAgentFirst)[0];
}

function isCodexPidFallback(agent: AgentStatus): boolean {
  return agent.provider === 'codex' && /^\d+$/.test(agent.providerInstanceId);
}

function isCodexSessionAgent(agent: AgentStatus): boolean {
  return agent.provider === 'codex' && !/^\d+$/.test(agent.providerInstanceId);
}

function isSameCodexWorkspace(agent: AgentStatus, candidate: AgentStatus): boolean {
  return Boolean(agent.cwd) &&
    pathsOverlap(normalizedPath(agent.cwd), normalizedPath(candidate.cwd));
}

function recentAgentFirst(a: AgentStatus, b: AgentStatus): number {
  return b.updatedAt.localeCompare(a.updatedAt) ||
    (b.startedAt ?? '').localeCompare(a.startedAt ?? '') ||
    a.providerInstanceId.localeCompare(b.providerInstanceId);
}

function normalizedPath(path?: string): string {
  return path?.replace(/\\/g, '/').replace(/\/+$/, '') ?? '';
}

function pathsOverlap(left: string, right: string): boolean {
  return Boolean(left) && Boolean(right) &&
    (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`));
}

function displayName(agent: AgentStatus, agents: AgentStatus[]): string {
  const base = `${providerLabel(agent.provider)} · ${workspaceName(agent)}`;
  const sameBase = agents
    .filter((item) => isVisibleAgent(item))
    .filter((item) => !isCodexPidDuplicate(item, new Map(agents.map((candidate) => [candidate.id, candidate]))))
    .filter((item) => `${providerLabel(item.provider)} · ${workspaceName(item)}` === base)
    .sort((a, b) => a.providerInstanceId.localeCompare(b.providerInstanceId));
  const index = sameBase.findIndex((item) => item.id === agent.id);
  return index > 0 ? `${base} #${index + 1}` : base;
}

function providerLabel(provider: AgentStatus['provider']): string {
  switch (provider) {
    case 'claude': return 'Claude';
    case 'codex': return 'Codex';
    case 'grok': return 'Grok';
    case 'gemini': return 'Gemini';
    case 'opencode': return 'OpenCode';
    default: return provider;
  }
}

function workspaceName(agent: AgentStatus): string {
  if (agent.cwd) {
    const normalized = agent.cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized.split('/').filter(Boolean).pop() ?? normalized;
  }
  return agent.pid ? `PID ${agent.pid}` : agent.providerInstanceId.slice(0, 8);
}

function reduceAgent(current: AgentStatus, event: AgentEvent): AgentStatus {
  const payload = event.payload as Record<string, unknown>;
  const base = { ...current, cwd: getCwd(payload) ?? current.cwd, updatedAt: event.ts };

  switch (event.type) {
    case 'started':
      return {
        ...base,
        status: 'running',
        task: getTask(payload, event.ts) ?? current.task,
        activeSince: event.ts
      };
    case 'heartbeat':
      return { ...base, status: current.status === 'idle' ? 'running' : current.status };
    case 'tool_started':
      return {
        ...base,
        status: 'running',
        activeSince: current.activeSince ?? event.ts,
        currentTool: getToolName(payload),
        task: getTask(payload, event.ts) ?? current.task,
        waitingFor: undefined,
        approval: undefined
      };
    case 'tool_finished':
      return {
        ...base,
        status: 'running',
        activeSince: current.activeSince,
        currentTool: getToolName(payload) ?? current.currentTool,
        task: getTask(payload, event.ts) ?? current.task,
        waitingFor: undefined,
        approval: undefined
      };
    case 'approval_requested':
      return {
        ...base,
        status: 'waiting_approval',
        currentTool: getToolName(payload),
        activeSince: event.ts,
        task: getTask(payload, event.ts) ?? current.task,
        waitingFor: summarizeApproval(payload)
      };
    case 'input_requested':
      return {
        ...base,
        status: 'waiting_input',
        activeSince: event.ts,
        task: getTask(payload, event.ts) ?? current.task,
        waitingFor: String(payload.waitingFor ?? payload.message ?? 'input needed')
      };
    case 'finished':
      return {
        ...base,
        status: 'finished',
        task: getTask(payload, event.ts) ?? current.task,
        finishedAt: event.ts,
        currentTool: undefined,
        waitingFor: undefined,
        activeSince: undefined,
        lastResult: String(payload.last_assistant_message ?? payload.lastAssistantMessage ?? payload.result ?? current.lastResult ?? '')
      };
    case 'error':
      return {
        ...base,
        status: 'error',
        finishedAt: event.ts,
        currentTool: undefined,
        activeSince: undefined,
        lastResult: String(payload.error ?? payload.message ?? current.lastResult ?? '')
      };
    default:
      return base;
  }
}

function createApproval(agent: AgentStatus, event: AgentEvent): ApprovalRequest {
  const payload = event.payload as Record<string, unknown>;
  const toolName = getToolName(payload) ?? 'unknown';
  const summary = summarizeApproval(payload);
  return {
    id: stableId(agent.id, toolName, summary, event.ts),
    agentId: agent.id,
    provider: agent.provider,
    toolName,
    summary,
    status: 'pending',
    payload: event.payload,
    createdAt: event.ts
  };
}

function getToolName(payload: Record<string, unknown>): string | undefined {
  return String(payload.tool_name ?? payload.toolName ?? payload.name ?? '').trim() || undefined;
}

function getTask(payload: Record<string, unknown>, beforeTs?: string): string | undefined {
  const raw = String(payload.prompt ?? payload.task ?? payload.message ?? '').trim();
  return stripGrokUserQueryTags(raw) || taskFromTranscript(payload, beforeTs);
}

// Grok wraps the user prompt in <user_query> tags in hook payloads.
function stripGrokUserQueryTags(text: string): string {
  return text.replace(/^<user_query>\s*/i, '').replace(/\s*<\/user_query>$/i, '').trim();
}

function getCwd(payload: Record<string, unknown>): string | undefined {
  return String(payload.cwd ?? '').trim() || undefined;
}

function summarizeApproval(payload: Record<string, unknown>): string {
  const toolName = getToolName(payload) ?? 'Tool';
  const input = (payload.tool_input ?? payload.toolInput) as Record<string, unknown> | undefined;
  const command = input?.command ?? input?.file_path ?? input?.path ?? input?.description;
  return command ? `${toolName} ${String(command)}` : `${toolName} approval requested`;
}

function taskFromTranscript(payload: Record<string, unknown>, beforeTs?: string): string | undefined {
  return taskStartFromTranscript(payload, beforeTs)?.task;
}

function taskStartFromTranscript(payload: Record<string, unknown>, beforeTs?: string): { startedAt: string; task?: string } | undefined {
  const transcriptPath = String(payload.transcript_path ?? payload.transcriptPath ?? '').trim();
  if (!transcriptPath) return undefined;
  return taskStartFromTranscriptFile(transcriptPath, beforeTs);
}

function comparableAgent(agent: AgentStatus): string {
  const { updatedAt, ...stable } = agent;
  return JSON.stringify(stable);
}

export function eventFromHook(provider: 'claude' | 'codex' | 'grok', input: Record<string, unknown>): AgentEvent {
  const providerInstanceId = String(input.session_id ?? input.sessionId ?? input.thread_id ?? input.conversation_id ?? newId('session'));
  const agentId = stableId(provider, providerInstanceId);
  const hookEvent = String(input.hook_event_name ?? input.hookEventName ?? input.type ?? '');
  const type: AgentEvent['type'] =
    // Grok uses PreToolUse as its approval gate; treat risky tools as approval requests.
    hookEvent === 'pre_tool_use' ? (isGrokApprovalTool(input) ? 'approval_requested' : 'tool_started') :
    hookEvent === 'PermissionRequest' ? 'approval_requested' :
    hookEvent === 'UserPromptSubmit' || hookEvent === 'user_prompt_submit' ? 'started' :
    hookEvent === 'PreToolUse' ? 'tool_started' :
    hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure' ? 'tool_finished' :
    hookEvent === 'post_tool_use' || hookEvent === 'post_tool_use_failure' ? 'tool_finished' :
    (hookEvent === 'Notification' || hookEvent === 'notification') && isWaitingNotification(input) ? 'input_requested' :
    hookEvent === 'Stop' || hookEvent === 'stop' || hookEvent === 'turn.completed' ? 'finished' :
    hookEvent === 'StopFailure' || hookEvent === 'stop_failure' || hookEvent === 'turn.failed' || hookEvent === 'error' ? 'error' :
    'heartbeat';

  return {
    agentId,
    provider,
    providerInstanceId,
    type,
    ts: new Date().toISOString(),
    payload: input
  };
}

// Grok has no dedicated permission hook, so the panel gates only tools matching this
// pattern via PreToolUse. An empty pattern disables grok approvals (monitor-only).
function isGrokApprovalTool(input: Record<string, unknown>): boolean {
  const pattern = process.env.AGENT_MONITOR_GROK_APPROVAL_TOOLS ??
    '^(run_terminal_command|run_terminal_cmd|write|edit|search_replace|apply_patch|write_file|create_file|delete_file|str_replace)$';
  if (!pattern) return false;
  const toolName = getToolName(input);
  if (!toolName) return false;
  try {
    return new RegExp(pattern).test(toolName);
  } catch {
    return false;
  }
}

function isWaitingNotification(input: Record<string, unknown>): boolean {
  const notificationType = String(input.notification_type ?? input.notificationType ?? '').toLowerCase();
  const message = String(input.message ?? input.title ?? '').toLowerCase();
  return notificationType.includes('permission') ||
    notificationType.includes('idle') ||
    message.includes('permission') ||
    message.includes('waiting');
}
