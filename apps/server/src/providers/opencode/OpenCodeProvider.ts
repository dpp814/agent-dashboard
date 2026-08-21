import { existsSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, AgentInstance, AgentStatus } from '@agent-monitor/shared';
import type { AgentProvider } from '../AgentProvider.js';
import { listProcesses, type ProcessRow } from '../../util/ps.js';
import { stableId } from '../../util/ids.js';

interface OpenCodeSession {
  id: string;
  title: string;
  directory: string;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
  tokens_input: number;
  tokens_output: number;
  model: string;
}

export interface OpenCodeMessage {
  role: string;
  content: string;
  timestamp: number;
  // 助手消息的 time.completed；未完成（仍在生成或被打断）时为空
  completed?: number;
}

// 进程启动后与当前进程匹配的会话，其最后活动时间允许的容差。
// 新开 opencode 时会话行要等第一条消息才写入，过早启动的进程按目录取最近会话会错配到上次的任务。
const OPENCODE_SESSION_START_GRACE_MS = 5_000;

export class OpenCodeProvider implements AgentProvider {
  readonly type = 'opencode' as const;
  private dbPath: string;
  private db?: DatabaseSync;
  private cache = new Map<string, AgentStatus>();
  private taskCache = new Map<string, { task: string | undefined; timeUpdated: number }>();

  constructor() {
    // OpenCode 数据库路径
    this.dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  }

  private getDatabase(): DatabaseSync | undefined {
    if (!existsSync(this.dbPath)) {
      return undefined;
    }
    if (!this.db) {
      try {
        this.db = new DatabaseSync(this.dbPath, { readOnly: true });
        this.db.exec('PRAGMA busy_timeout = 5000');
      } catch (error) {
        console.error('Failed to open OpenCode database:', error);
        return undefined;
      }
    }
    return this.db;
  }

  async discover(): Promise<AgentInstance[]> {
    const now = new Date().toISOString();
    const processRows = await listProcesses();
    const opencodeRows = processRows.filter((row) => isOpencodeCliProcess(row.command) && !isStoppedProcess(row));
    const db = this.getDatabase();
    const sessions = db ? this.loadSessions(db, 100, false) : [];
    const seen = new Set<string>();
    const assignedSessions = new Set<string>();
    const explicitlyAssignedPids = new Set<number>();

    // 显式指定了会话（opencode -s/--session）优先，直接绑定该会话
    for (const row of opencodeRows) {
      const explicitId = sessionIdFromCommand(row.command);
      if (!explicitId) continue;
      const session = sessions.find((item) => item.id === explicitId);
      if (!session) continue;
      explicitlyAssignedPids.add(row.pid);
      assignedSessions.add(session.id);
      seen.add(this.buildSessionCard(session, row, now));
    }

    // 其余进程按工作目录分配会话：新进程优先，取「启动后有活动」且尚未分配的最近会话，
    // 避免同一目录多开 opencode 时全部错配到同一个会话
    const rowsByDirectory = new Map<string, ProcessRow[]>();
    for (const row of opencodeRows) {
      if (explicitlyAssignedPids.has(row.pid)) continue;
      const cwd = processCwd(row);
      if (!cwd) continue;
      const list = rowsByDirectory.get(cwd) ?? [];
      list.push(row);
      rowsByDirectory.set(cwd, list);
    }

    for (const [cwd, rows] of rowsByDirectory) {
      const normalizedDir = normalizePath(cwd);
      const dirSessions = sessions
        .filter((session) => !assignedSessions.has(session.id) && normalizePath(session.directory) === normalizedDir)
        .sort((a, b) => b.time_updated - a.time_updated);

      for (const row of [...rows].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))) {
        const session = dirSessions.find((item) => !assignedSessions.has(item.id) && sessionActiveSince(row.startedAt, item));
        if (session) {
          assignedSessions.add(session.id);
          seen.add(this.buildSessionCard(session, row, now));
        } else {
          // 进程在跑但会话还没落库（新窗口还没发第一条消息）：展示「待命题」临时卡片
          seen.add(this.buildPlaceholderCard(row, cwd, now));
        }
      }
    }

    for (const [id, agent] of this.cache) {
      if (!seen.has(id) && !['finished', 'error'].includes(agent.status)) {
        this.cache.set(id, {
          ...agent,
          status: 'idle',
          currentTool: undefined,
          waitingFor: undefined,
          activeSince: undefined,
          updatedAt: now
        });
      }
    }

    return [...this.cache.values()].filter((agent) => agent.status !== 'idle');
  }

  private buildSessionCard(session: OpenCodeSession, row: ProcessRow, now: string): string {
    const id = stableId(this.type, session.id);
    const existing = this.cache.get(id);
    const task = this.sessionTask(session) ?? existing?.task ?? session.title;
    this.cache.set(id, {
      id,
      provider: this.type,
      providerInstanceId: session.id,
      name: existing?.name ?? opencodeName(session.id),
      cwd: session.directory,
      pid: row.pid,
      status: 'running',
      task,
      startedAt: existing?.startedAt ?? new Date(session.time_created).toISOString(),
      updatedAt: now,
      metadata: {
        sessionId: session.id,
        title: session.title,
        model: openCodeModelId(session.model),
        tokensInput: session.tokens_input,
        tokensOutput: session.tokens_output,
        updatedAt: new Date(session.time_updated).toISOString()
      }
    });
    return id;
  }

  private buildPlaceholderCard(row: ProcessRow, cwd: string, now: string): string {
    const id = stableId(this.type, `proc_${row.pid}`);
    const existing = this.cache.get(id);
    this.cache.set(id, {
      id,
      provider: this.type,
      providerInstanceId: `proc_${row.pid}`,
      name: existing?.name ?? opencodeName(`proc_${row.pid}`),
      cwd,
      pid: row.pid,
      status: 'running',
      task: '待命题',
      startedAt: existing?.startedAt ?? new Date(row.startedAt ?? Date.now()).toISOString(),
      updatedAt: now,
      metadata: { pendingSession: true }
    });
    return id;
  }

  async getStatus(id: string): Promise<AgentStatus | undefined> {
    return this.cache.get(id);
  }

  async subscribe(): Promise<() => void> {
    // OpenCode 纯历史模式，不支持实时订阅
    return () => {};
  }

  // 当前仍有 opencode 进程存活的会话 ID（用于历史同步：活会话重扫以捕获新完成的回合）
  getLiveSessionIds(): Set<string> {
    const ids = new Set<string>();
    for (const agent of this.cache.values()) {
      if (agent.status === 'running' && agent.providerInstanceId) ids.add(agent.providerInstanceId);
    }
    return ids;
  }

  // 供外部调用，获取所有会话（用于历史同步）
  getActiveSessions(): OpenCodeSession[] {
    const db = this.getDatabase();
    if (!db) return [];
    return this.loadSessions(db, undefined, true);
  }

  // 获取会话的所有消息（含正文；content 为空表示该消息没有文本部件）
  getSessionMessages(sessionId: string): OpenCodeMessage[] {
    const db = this.getDatabase();
    if (!db) return [];

    try {
      const messages = db.prepare(`
        SELECT id, data, time_created
        FROM message
        WHERE session_id = ?
        ORDER BY time_created ASC
      `).all(sessionId) as Array<{ id: string; data: string; time_created: number }>;

      return messages.map((msg) => {
        const data = parseJson(msg.data);
        const role = String(data.role ?? '').trim();
        const time = data.time && typeof data.time === 'object'
          ? data.time as { completed?: unknown }
          : undefined;
        const completed = Number(time?.completed ?? NaN);
        return {
          role: role || 'unknown',
          content: role === 'user' || role === 'assistant' ? this.extractMessageText(db, msg.id) : '',
          timestamp: Number(msg.time_created),
          completed: role === 'assistant' && Number.isFinite(completed) && completed > 0 ? completed : undefined
        };
      });
    } catch (error) {
      console.error('Failed to get OpenCode session messages:', error);
      return [];
    }
  }

  private loadSessions(db: DatabaseSync, limit?: number, includeArchived = false): OpenCodeSession[] {
    try {
      const sql = `
        SELECT id, title, directory, time_created, time_updated, time_archived,
               tokens_input, tokens_output, model
        FROM session
        ${includeArchived ? '' : 'WHERE time_archived IS NULL'}
        ORDER BY time_updated DESC
        ${limit === undefined ? '' : 'LIMIT ?'}
      `;
      return (limit === undefined ? db.prepare(sql).all() : db.prepare(sql).all(limit)) as unknown as OpenCodeSession[];
    } catch (error) {
      console.error('Failed to get OpenCode sessions:', error);
      return [];
    }
  }

  // 会话当前事务 = 最近一条用户消息的正文（随会话更新刷新，避免继续提问后仍显示旧问题）
  private sessionTask(session: OpenCodeSession): string | undefined {
    const cached = this.taskCache.get(session.id);
    if (cached && cached.timeUpdated >= session.time_updated) return cached.task;
    const task = latestUserMessageText(this.getSessionMessages(session.id));
    this.taskCache.set(session.id, { task, timeUpdated: session.time_updated });
    return task;
  }

  private extractMessageText(db: DatabaseSync, messageId: string): string {
    try {
      const parts = db.prepare(`
        SELECT data
        FROM part
        WHERE message_id = ?
        ORDER BY time_created ASC
      `).all(messageId) as Array<{ data: string }>;

      const textParts = parts
        .map((part) => parseJson(part.data))
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => String(part.text).trim())
        .filter(Boolean);

      return textParts.join('\n');
    } catch (error) {
      return '';
    }
  }
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function latestUserMessageText(messages: Array<{ role: string; content: string }>): string | undefined {
  for (const message of [...messages].reverse()) {
    if (message.role === 'user' && message.content.trim()) return message.content.trim();
  }
  return undefined;
}

function isOpencodeCliProcess(command: string): boolean {
  if (/agent-monitor|agent-hook-forwarder|rg\s+.*opencode|ps\s+-eo|which\s+opencode/i.test(command)) return false;
  if (/^\S*\/bin\/opencode(\s|$)/.test(command)) return true;
  return /^opencode(\s|$)/.test(command);
}

function isStoppedProcess(row: ProcessRow): boolean {
  return typeof row.stat === 'string' && row.stat.startsWith('T');
}

function sessionIdFromCommand(command: string): string | undefined {
  const match = command.match(/\b(?:-s|--session)\s+(ses_[A-Za-z0-9]+)\b/i);
  return match ? match[1] : undefined;
}

// 会话对某进程来说「活跃」：其最后活动时间不早于进程启动（允许少量容差）。
// 新会话行要等第一条消息才写入，进程启动后还没有活动的会话说明它还没落库，不应错配。
function sessionActiveSince(processStartedAt: number | undefined, session: OpenCodeSession): boolean {
  if (processStartedAt === undefined) return true;
  return session.time_updated >= processStartedAt - OPENCODE_SESSION_START_GRACE_MS;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function opencodeName(providerInstanceId: string): string {
  return `OpenCode ${providerInstanceId.slice(0, 8)}`;
}

function openCodeModelId(modelJson: string): string | undefined {
  const parsed = parseJson(modelJson);
  const modelId = String(parsed.id ?? '').trim();
  return modelId || undefined;
}

function processCwd(row: ProcessRow): string | undefined {
  if (row.source === 'windows' || row.pid < 1 || process.platform === 'win32') return undefined;
  try {
    return readlinkSync(`/proc/${row.pid}/cwd`);
  } catch {
    return undefined;
  }
}
