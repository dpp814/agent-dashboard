import { readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AgentInstance, AgentStatus } from '@agent-monitor/shared';
import type { AgentProvider } from '../AgentProvider.js';
import { commandExists, execFileText } from '../../util/exec.js';
import { listProcesses, type ProcessRow } from '../../util/ps.js';
import { stableId } from '../../util/ids.js';

interface ClaudeAgentRow {
  id?: string;
  cwd?: string;
  kind?: string;
  startedAt?: string;
  state?: 'working' | 'blocked' | 'done' | 'failed' | 'stopped';
  pid?: number;
  status?: string;
  waitingFor?: string;
  sessionId?: string;
  name?: string;
  source?: 'linux' | 'windows';
  stat?: string;
}

export class ClaudeProvider implements AgentProvider {
  type = 'claude' as const;
  private cache = new Map<string, AgentStatus>();

  async discover(): Promise<AgentInstance[]> {
    const rows = await this.readAgentRows();
    const now = new Date().toISOString();
    const seen = new Set<string>();

    for (const row of rows) {
      const providerInstanceId = row.id ?? row.sessionId ?? stableId(row.cwd, row.startedAt, row.name);
      const id = stableId(this.type, providerInstanceId);
      seen.add(id);
      this.cache.set(id, {
        id,
        provider: this.type,
        providerInstanceId,
        name: row.name || `Claude ${providerInstanceId.slice(0, 8)}`,
        cwd: row.cwd,
        pid: row.pid,
        startedAt: row.startedAt,
        task: claudeTask(row),
        status: mapClaudeState(row),
        waitingFor: row.waitingFor,
        updatedAt: now,
        finishedAt: row.state === 'done' || row.state === 'failed' || row.state === 'stopped' ? now : undefined,
        metadata: row as Record<string, unknown>
      });
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

  async getStatus(id: string): Promise<AgentStatus | undefined> {
    return this.cache.get(id);
  }

  async subscribe(): Promise<() => void> {
    return () => {};
  }

  toEvents(): AgentEvent[] {
    const now = new Date().toISOString();
    return [...this.cache.values()].map((agent) => ({
      agentId: agent.id,
      provider: this.type,
      providerInstanceId: agent.providerInstanceId,
      type: agent.status === 'waiting_approval'
        ? 'approval_requested'
        : agent.status === 'waiting_input'
          ? 'input_requested'
          : agent.status === 'finished'
            ? 'finished'
            : agent.status === 'error'
              ? 'error'
              : 'heartbeat',
      ts: now,
      payload: agent
    }));
  }

  private async readAgentRows(): Promise<ClaudeAgentRow[]> {
    const processRows = await readClaudeProcessRows();
    if (!(await commandExists('claude'))) {
      return processRows;
    }
    try {
      const raw = await execFileText('claude', ['agents', '--json', '--all'], 5000);
      const parsed = JSON.parse(raw);
      const agentRows = (Array.isArray(parsed) ? parsed as ClaudeAgentRow[] : [])
        .filter((row) => hasLiveProcessOrTerminalState(row, processRows));
      const knownPids = new Set(agentRows.map((row) => row.pid).filter((pid): pid is number => typeof pid === 'number'));
      return [
        ...agentRows.map((row) => mergeProcessRow(row, processRows)),
        ...processRows.filter((row) => !row.pid || !knownPids.has(row.pid))
      ];
    } catch {
      return processRows;
    }
  }
}

function claudeTask(row: ClaudeAgentRow): string | undefined {
  const sessionId = row.sessionId ?? row.id;
  if (!sessionId || !row.cwd) return undefined;
  return taskFromTranscript(join(homedir(), '.claude', 'projects', claudeProjectSlug(row.cwd), `${sessionId}.jsonl`));
}

function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/\//g, '-');
}

function taskFromTranscript(path: string): string | undefined {
  try {
    const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
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

function mapClaudeState(row: ClaudeAgentRow): AgentStatus['status'] {
  if (row.state === 'working') return 'running';
  if (row.state === 'blocked' && row.waitingFor?.toLowerCase().includes('permission')) return 'waiting_approval';
  if (row.state === 'blocked') return 'waiting_input';
  if (row.state === 'done') return 'finished';
  if (row.state === 'failed') return 'error';
  if (row.status === 'process_running') return 'running';
  return 'idle';
}

async function readClaudeProcessRows(): Promise<ClaudeAgentRow[]> {
  const rows = await listProcesses();
  return rows.filter((row) => isClaudeCliProcess(row.command)).map(processRowToClaudeAgent);
}

function processRowToClaudeAgent(row: ProcessRow): ClaudeAgentRow {
  return {
    id: `process:${row.pid}`,
    kind: 'interactive',
    pid: row.pid,
    name: `Claude ${row.pid}`,
    status: row.stat?.startsWith('T') ? 'process_idle' : 'process_running',
    source: row.source,
    stat: row.stat,
    cwd: processCwd(row)
  };
}

function hasLiveProcessOrTerminalState(row: ClaudeAgentRow, processRows: ClaudeAgentRow[]): boolean {
  if (!row.pid) return true;
  if (row.state === 'done' || row.state === 'failed' || row.state === 'stopped') return true;
  return processRows.some((processRow) => processRow.pid === row.pid);
}

function mergeProcessRow(agentRow: ClaudeAgentRow, processRows: ClaudeAgentRow[]): ClaudeAgentRow {
  if (!agentRow.pid) return agentRow;
  const processRow = processRows.find((row) => row.pid === agentRow.pid);
  if (!processRow) return agentRow;
  if (agentRow.state && agentRow.state !== 'stopped') return agentRow;
  return {
    ...agentRow,
    status: processRow.status,
    source: processRow.source,
    cwd: agentRow.cwd ?? processRow.cwd
  };
}

function isClaudeCliProcess(command: string): boolean {
  if (/agent-monitor|agent-hook-forwarder|claude\s+agents\b|rg\s+.*claude|ps\s+-eo/i.test(command)) return false;
  if (/^\S*node\s+\S*\/(?:bin\/)?claude(\s|$)/i.test(command)) return true;
  if (/(^|\s|\/)claude(\s|$)/i.test(command)) return true;
  if (/@anthropic-ai\/claude-code|claude-code/i.test(command)) return true;
  return false;
}

function processCwd(row: ProcessRow): string | undefined {
  if (row.source === 'windows' || row.pid < 1) return undefined;
  if (process.platform === 'win32') return undefined;
  try {
    return readlinkSync(`/proc/${row.pid}/cwd`);
  } catch {
    return undefined;
  }
}
