import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, AgentStatus, ApprovalRequest, DashboardStats, TaskHistory } from '@agent-monitor/shared';
import { serverConfig } from '../config.js';

export class AppDatabase {
  private db = new DatabaseSync(join(serverConfig.dataDir, 'agent-monitor.sqlite'));

  constructor() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        name TEXT NOT NULL,
        cwd TEXT,
        pid INTEGER,
        status TEXT NOT NULL,
        task TEXT,
        current_tool TEXT,
        waiting_for TEXT,
        last_result TEXT,
        active_since TEXT,
        started_at TEXT,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        type TEXT NOT NULL,
        ts TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_instance_id TEXT,
        task TEXT,
        started_at TEXT,
        ended_at TEXT,
        duration_ms INTEGER,
        final_status TEXT NOT NULL,
        result_summary TEXT
      );
    `);
    this.addColumnIfMissing('agents', 'active_since', 'TEXT');
    this.addColumnIfMissing('task_history', 'provider_instance_id', 'TEXT');
    this.dedupeCompletionHistory();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_history_agent_ended
      ON task_history(agent_id, ended_at)
      WHERE ended_at IS NOT NULL;
    `);
    this.backfillZeroDurationHistory();
    this.backfillMissingCompletionHistory();
  }

  upsertAgent(agent: AgentStatus): void {
    this.db.prepare(`
      INSERT INTO agents (
        id, provider, provider_instance_id, name, cwd, pid, status, task, current_tool,
        waiting_for, last_result, active_since, started_at, updated_at, finished_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        provider_instance_id = excluded.provider_instance_id,
        name = excluded.name,
        cwd = excluded.cwd,
        pid = excluded.pid,
        status = excluded.status,
        task = excluded.task,
        current_tool = excluded.current_tool,
        waiting_for = excluded.waiting_for,
        last_result = excluded.last_result,
        active_since = excluded.active_since,
        started_at = COALESCE(agents.started_at, excluded.started_at),
        updated_at = excluded.updated_at,
        finished_at = excluded.finished_at,
        metadata_json = excluded.metadata_json
    `).run(
      agent.id,
      agent.provider,
      agent.providerInstanceId,
      agent.name,
      agent.cwd ?? null,
      agent.pid ?? null,
      agent.status,
      agent.task ?? null,
      agent.currentTool ?? null,
      agent.waitingFor ?? null,
      agent.lastResult ?? null,
      agent.activeSince ?? null,
      agent.startedAt ?? null,
      agent.updatedAt,
      agent.finishedAt ?? null,
      JSON.stringify(agent.metadata ?? {})
    );
  }

  insertEvent(event: AgentEvent): void {
    this.db.prepare(`
      INSERT INTO agent_events (agent_id, provider, provider_instance_id, type, ts, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.agentId,
      event.provider,
      event.providerInstanceId,
      event.type,
      event.ts,
      JSON.stringify(event.payload)
    );
  }

  upsertApproval(approval: ApprovalRequest): void {
    this.db.prepare(`
      INSERT INTO approval_requests (
        id, agent_id, provider, tool_name, summary, payload_json, status, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        resolved_at = excluded.resolved_at,
        payload_json = excluded.payload_json
    `).run(
      approval.id,
      approval.agentId,
      approval.provider,
      approval.toolName,
      approval.summary,
      JSON.stringify(approval.payload),
      approval.status,
      approval.createdAt,
      approval.resolvedAt ?? null
    );
  }

  insertHistory(row: Omit<TaskHistory, 'id'>): TaskHistory {
    this.db.prepare(`
      INSERT OR IGNORE INTO task_history (
        agent_id, provider, provider_instance_id, task, started_at, ended_at, duration_ms, final_status, result_summary
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.agentId,
      row.provider,
      row.providerInstanceId ?? null,
      row.task ?? null,
      row.startedAt ?? null,
      row.endedAt ?? null,
      row.durationMs ?? null,
      row.finalStatus,
      row.resultSummary ?? null
    );
    const existing = row.endedAt
      ? this.db.prepare(`
        SELECT * FROM task_history
        WHERE agent_id = ? AND ended_at = ?
        ORDER BY id DESC
        LIMIT 1
      `).get(row.agentId, row.endedAt) as Record<string, unknown> | undefined
      : undefined;
    if (existing) return rowToHistory(existing);
    const inserted = this.db.prepare('SELECT * FROM task_history WHERE id = last_insert_rowid()')
      .get() as Record<string, unknown>;
    return rowToHistory(inserted);
  }

  hasHistoryForCompletion(agentId: string, endedAt: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM task_history
      WHERE agent_id = ? AND ended_at = ?
      LIMIT 1
    `).get(agentId, endedAt);
    return Boolean(row);
  }

  findLatestTaskStart(agentId: string, beforeTs: string): { startedAt: string; task?: string } | undefined {
    const row = this.db.prepare(`
      SELECT ts, payload_json FROM agent_events
      WHERE agent_id = ? AND type = 'started' AND ts <= ?
      ORDER BY ts DESC
      LIMIT 1
    `).get(agentId, beforeTs) as { ts: string; payload_json: string } | undefined;
    if (!row) return undefined;
    const payload = parseJsonObject(row.payload_json);
    return {
      startedAt: row.ts,
      task: nullableString(payload.prompt ?? payload.task ?? payload.message) ?? taskFromTranscript(payload, row.ts)
    };
  }

  listAgents(): AgentStatus[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY updated_at DESC').all().map(rowToAgent);
  }

  listApprovals(): ApprovalRequest[] {
    return this.db.prepare(`
      SELECT * FROM approval_requests
      WHERE status = 'pending'
      ORDER BY created_at DESC
    `).all().map(rowToApproval);
  }

  expirePendingApprovals(provider: AgentStatus['provider'], resolvedAt: string): string[] {
    const rows = this.db.prepare(`
      SELECT agent_id FROM approval_requests
      WHERE provider = ? AND status = 'pending'
    `).all(provider) as Array<{ agent_id: string }>;
    this.db.prepare(`
      UPDATE approval_requests
      SET status = 'expired', resolved_at = ?
      WHERE provider = ? AND status = 'pending'
    `).run(resolvedAt, provider);
    return rows.map((row) => row.agent_id);
  }

  expireInvalidPendingApprovals(resolvedAt: string): string[] {
    const approvals = this.listApprovals().filter(isInvalidApproval);
    if (!approvals.length) return [];
    const update = this.db.prepare(`
      UPDATE approval_requests
      SET status = 'expired', resolved_at = ?
      WHERE id = ? AND status = 'pending'
    `);
    for (const approval of approvals) update.run(resolvedAt, approval.id);
    return approvals.map((approval) => approval.agentId);
  }

  listHistory(search = '', limit = 50, offset = 0): TaskHistory[] {
    const like = `%${search}%`;
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const safeOffset = Math.max(0, Math.floor(offset));
    return this.db.prepare(`
      SELECT * FROM task_history
      WHERE (? = '%%' OR task LIKE ? OR provider LIKE ? OR provider_instance_id LIKE ? OR agent_id LIKE ? OR final_status LIKE ? OR result_summary LIKE ?)
      ORDER BY COALESCE(ended_at, started_at) DESC
      LIMIT ? OFFSET ?
    `).all(like, like, like, like, like, like, like, safeLimit, safeOffset).map(rowToHistory);
  }

  countTodayHistory(sinceIso: string, beforeIso: string): DashboardStats {
    const rows = this.db.prepare(`
      SELECT final_status AS status, COUNT(*) AS count
      FROM task_history
      WHERE ended_at >= ? AND ended_at < ? AND final_status IN ('finished', 'error')
      GROUP BY final_status
    `).all(sinceIso, beforeIso) as Array<{ status: string; count: number }>;
    return {
      todayFinished: rows.find((row) => row.status === 'finished')?.count ?? 0,
      todayError: rows.find((row) => row.status === 'error')?.count ?? 0
    };
  }

  cleanupHistory(cutoffIso: string): void {
    this.db.prepare('DELETE FROM task_history WHERE ended_at IS NOT NULL AND ended_at < ?').run(cutoffIso);
  }

  cleanupEvents(cutoffIso: string): void {
    this.db.prepare('DELETE FROM agent_events WHERE ts < ?').run(cutoffIso);
  }

  cleanupResolvedApprovals(cutoffIso: string): void {
    this.db.prepare(`
      DELETE FROM approval_requests
      WHERE status != 'pending' AND resolved_at IS NOT NULL AND resolved_at < ?
    `).run(cutoffIso);
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private backfillZeroDurationHistory(): void {
    const rows = this.db.prepare(`
      SELECT id, agent_id, ended_at FROM task_history
      WHERE duration_ms = 0 AND ended_at IS NOT NULL
      ORDER BY id DESC
      LIMIT 500
    `).all() as Array<{ id: number; agent_id: string; ended_at: string }>;
    const update = this.db.prepare('UPDATE task_history SET started_at = ?, duration_ms = ? WHERE id = ?');
    for (const row of rows) {
      const started = this.findLatestTaskStart(row.agent_id, row.ended_at);
      if (!started || started.startedAt === row.ended_at) continue;
      const duration = Date.parse(row.ended_at) - Date.parse(started.startedAt);
      if (Number.isFinite(duration) && duration >= 0) update.run(started.startedAt, duration, row.id);
    }
  }

  private dedupeCompletionHistory(): void {
    this.db.exec(`
      DELETE FROM task_history
      WHERE ended_at IS NOT NULL
        AND id NOT IN (
          SELECT MIN(id)
          FROM task_history
          WHERE ended_at IS NOT NULL
          GROUP BY agent_id, ended_at
        );
    `);
  }

  private backfillMissingCompletionHistory(): void {
    const rows = this.db.prepare(`
      SELECT e.id, e.agent_id, e.provider, e.provider_instance_id, e.type, e.ts, e.payload_json
      FROM agent_events e
      WHERE e.type IN ('finished', 'error')
        AND NOT EXISTS (
          SELECT 1 FROM task_history h
          WHERE h.agent_id = e.agent_id AND h.ended_at = e.ts
        )
      ORDER BY e.id DESC
      LIMIT 500
    `).all() as Array<{
      id: number;
      agent_id: string;
      provider: TaskHistory['provider'];
      provider_instance_id: string | null;
      type: 'finished' | 'error';
      ts: string;
      payload_json: string;
    }>;

    for (const row of rows.reverse()) {
      const payload = parseJsonObject(row.payload_json);
      const started = this.findLatestTaskStart(row.agent_id, row.ts);
      if (!started) continue;
      const resultSummary = nullableString(
        payload.last_assistant_message ?? payload.result ?? payload.error ?? payload.message
      );
      const task = nullableString(payload.prompt ?? payload.task ?? payload.message) ??
        taskFromTranscript(payload, row.ts) ??
        started.task;
      if (!task && !resultSummary) continue;
      this.insertHistory({
        agentId: row.agent_id,
        provider: row.provider,
        providerInstanceId: nullableString(row.provider_instance_id),
        task,
        startedAt: started.startedAt,
        endedAt: row.ts,
        durationMs: completionDurationMs(started.startedAt, row.ts),
        finalStatus: row.type === 'finished' ? 'finished' : 'error',
        resultSummary
      });
    }
  }
}

function rowToAgent(row: Record<string, unknown>): AgentStatus {
  return {
    id: String(row.id),
    provider: row.provider as AgentStatus['provider'],
    providerInstanceId: String(row.provider_instance_id),
    name: String(row.name),
    cwd: nullableString(row.cwd),
    pid: nullableNumber(row.pid),
    status: row.status as AgentStatus['status'],
    task: nullableString(row.task),
    currentTool: nullableString(row.current_tool),
    waitingFor: nullableString(row.waiting_for),
    lastResult: nullableString(row.last_result),
    activeSince: nullableString(row.active_since),
    startedAt: nullableString(row.started_at),
    updatedAt: String(row.updated_at),
    finishedAt: nullableString(row.finished_at),
    metadata: parseJsonObject(row.metadata_json)
  };
}

function rowToApproval(row: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    provider: row.provider as ApprovalRequest['provider'],
    toolName: String(row.tool_name),
    summary: String(row.summary),
    payload: parseJson(row.payload_json),
    status: row.status as ApprovalRequest['status'],
    createdAt: String(row.created_at),
    resolvedAt: nullableString(row.resolved_at)
  };
}

function rowToHistory(row: Record<string, unknown>): TaskHistory {
  return {
    id: Number(row.id),
    agentId: String(row.agent_id),
    provider: row.provider as TaskHistory['provider'],
    providerInstanceId: nullableString(row.provider_instance_id),
    task: nullableString(row.task),
    startedAt: nullableString(row.started_at),
    endedAt: nullableString(row.ended_at),
    durationMs: nullableNumber(row.duration_ms),
    finalStatus: row.final_status as TaskHistory['finalStatus'],
    resultSummary: nullableString(row.result_summary)
  };
}

function isInvalidApproval(approval: ApprovalRequest): boolean {
  const payload = approval.payload as Record<string, unknown>;
  return approval.toolName === 'unknown' && !payload.tool_input && !payload.toolInput;
}

function parseJson(value: unknown): unknown {
  try {
    return JSON.parse(String(value ?? '{}'));
  } catch {
    return {};
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function nullableNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function completionDurationMs(startedAt: string, endedAt: string): number | undefined {
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function taskFromTranscript(payload: Record<string, unknown>, beforeTs?: string): string | undefined {
  const transcriptPath = String(payload.transcript_path ?? payload.transcriptPath ?? '').trim();
  if (!transcriptPath) return undefined;
  const cutoff = beforeTs ? Date.parse(beforeTs) : undefined;
  const hasCutoff = typeof cutoff === 'number' && Number.isFinite(cutoff);
  try {
    const lines = readFileSync(transcriptPath, 'utf8').trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      const rowTs = Date.parse(String(row.timestamp ?? ''));
      if (hasCutoff && Number.isFinite(rowTs) && rowTs > cutoff) continue;
      if (row.type !== 'user' || row.promptSource !== 'typed') continue;
      const text = userMessageText(row.message);
      if (text) return text;
    }
  } catch {
    return undefined;
  }
}

function userMessageText(message: unknown): string | undefined {
  const row = message as Record<string, unknown> | undefined;
  if (!row || row.role !== 'user') return undefined;
  if (typeof row.content === 'string') return row.content.trim() || undefined;
  if (!Array.isArray(row.content)) return undefined;
  return row.content
    .map((item) => typeof item === 'string'
      ? item
      : typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text'
        ? String((item as Record<string, unknown>).text ?? '')
        : '')
    .join('')
    .trim() || undefined;
}
