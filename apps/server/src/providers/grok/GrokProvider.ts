import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentInstance, AgentStatus } from '@agent-monitor/shared';
import type { AgentProvider } from '../AgentProvider.js';
import { listProcesses, type ProcessRow } from '../../util/ps.js';
import { stableId } from '../../util/ids.js';

interface GrokActiveSession {
  session_id?: string;
  pid?: number;
  cwd?: string;
  opened_at?: string;
}

export class GrokProvider implements AgentProvider {
  type = 'grok' as const;
  private cache = new Map<string, AgentStatus>();
  private seenCounts = new Map<string, number>();

  async discover(): Promise<AgentInstance[]> {
    const now = new Date().toISOString();
    const processRows = await listProcesses();
    const grokRows = processRows.filter((row) => isGrokCliProcess(row.command) && !isStoppedProcess(row));
    const registrySessions = readActiveSessions().filter((session) => hasLiveGrokProcess(session, grokRows));
    const registryPids = new Set(registrySessions.map((session) => session.pid));
    const seen = new Set<string>();

    for (const session of registrySessions) {
      const providerInstanceId = session.session_id ?? String(session.pid);
      const id = stableId(this.type, providerInstanceId);
      seen.add(id);
      const existing = this.cache.get(id);
      const summary = readSessionSummary(session);
      this.cache.set(id, {
        id,
        provider: this.type,
        providerInstanceId,
        name: existing?.name ?? grokName(providerInstanceId, session.pid),
        cwd: session.cwd,
        pid: session.pid,
        status: 'running',
        task: summary?.task ?? existing?.task,
        currentTool: existing?.currentTool,
        startedAt: existing?.startedAt ?? session.opened_at ?? now,
        updatedAt: now,
        metadata: {
          sessionId: session.session_id,
          model: summary?.model,
          openedAt: session.opened_at
        }
      });
    }

    // Fallback for grok processes missing from the registry (stale/partial registry writes).
    for (const row of grokRows) {
      if (registryPids.has(row.pid)) continue;
      const providerInstanceId = String(row.pid);
      const id = stableId(this.type, providerInstanceId);
      seen.add(id);
      const seenCount = (this.seenCounts.get(id) ?? 0) + 1;
      this.seenCounts.set(id, seenCount);
      if (seenCount < 2) continue;
      const existing = this.cache.get(id);
      this.cache.set(id, {
        id,
        provider: this.type,
        providerInstanceId,
        name: existing?.name ?? grokName(providerInstanceId, row.pid),
        cwd: existing?.cwd ?? processCwd(row),
        pid: row.pid,
        status: 'running',
        task: existing?.task,
        currentTool: existing?.currentTool,
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
        metadata: { command: row.command }
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
    for (const id of this.seenCounts.keys()) {
      if (!seen.has(id)) this.seenCounts.delete(id);
    }

    return [...this.cache.values()].filter((agent) => agent.status !== 'idle');
  }

  async getStatus(id: string): Promise<AgentStatus | undefined> {
    return this.cache.get(id);
  }

  async subscribe(): Promise<() => void> {
    return () => {};
  }
}

function grokHome(): string {
  return process.env.GROK_HOME ?? join(homedir(), '.grok');
}

function readActiveSessions(): GrokActiveSession[] {
  try {
    const raw = readFileSync(join(grokHome(), 'active_sessions.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed as GrokActiveSession[] : [])
      .filter((session) => typeof session.pid === 'number' || typeof session.session_id === 'string');
  } catch {
    return [];
  }
}

// Registry entries can outlive their process; only trust ones backed by a live grok process.
function hasLiveGrokProcess(session: GrokActiveSession, grokRows: ProcessRow[]): boolean {
  if (typeof session.pid !== 'number') return false;
  return grokRows.some((row) => row.pid === session.pid);
}

function readSessionSummary(session: GrokActiveSession): { task?: string; model?: string } | undefined {
  if (!session.session_id || !session.cwd) return undefined;
  const path = join(grokHome(), 'sessions', encodeURIComponent(session.cwd), session.session_id, 'summary.json');
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const task = String(parsed.generated_title ?? parsed.session_summary ?? '').trim() || undefined;
    const model = String(parsed.current_model_id ?? '').trim() || undefined;
    return { task, model };
  } catch {
    return undefined;
  }
}

function isGrokCliProcess(command: string): boolean {
  if (/agent-monitor|agent-hook-forwarder|rg\s+.*grok|ps\s+-eo/i.test(command)) return false;
  if (/^\S*\/bin\/grok(\s|$)/.test(command)) return true;
  return /^grok(\s|$)/.test(command);
}

function isStoppedProcess(row: ProcessRow): boolean {
  return typeof row.stat === 'string' && row.stat.startsWith('T');
}

function grokName(providerInstanceId: string, pid?: number): string {
  return providerInstanceId === String(pid) ? `Grok ${pid}` : `Grok ${providerInstanceId.slice(0, 8)}`;
}

function processCwd(row: ProcessRow): string | undefined {
  if (row.source === 'windows' || row.pid < 1 || process.platform === 'win32') return undefined;
  try {
    return readlinkSync(`/proc/${row.pid}/cwd`);
  } catch {
    return undefined;
  }
}
