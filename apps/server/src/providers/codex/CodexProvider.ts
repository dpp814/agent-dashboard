import { readlinkSync } from 'node:fs';
import type { AgentInstance, AgentStatus } from '@agent-monitor/shared';
import type { AgentProvider } from '../AgentProvider.js';
import { listProcesses, type ProcessRow } from '../../util/ps.js';
import { stableId } from '../../util/ids.js';

export class CodexProvider implements AgentProvider {
  type = 'codex' as const;
  private cache = new Map<string, AgentStatus>();
  private seenCounts = new Map<string, number>();

  async discover(): Promise<AgentInstance[]> {
    const now = new Date().toISOString();
    const rows = await listProcesses();
    const rawCodexRows = rows.filter((row) => isCodexCliProcess(row.command) && !isStoppedProcess(row));
    const nativeParentIds = new Set(
      rawCodexRows
        .filter((row) => /@openai\/codex|codex-linux|codex-[a-z0-9_-]+/i.test(row.command))
        .map((row) => row.ppid)
        .filter((ppid): ppid is number => typeof ppid === 'number')
    );
    const codexRows = rawCodexRows.filter((row) => !/^node\b/.test(row.command) || !nativeParentIds.has(row.pid));
    const grouped = groupCodexRows(codexRows);
    const seen = new Set<string>();

    for (const group of grouped) {
      const providerInstanceId = group.providerInstanceId;
      const row = group.representative;
      const id = stableId(this.type, providerInstanceId);
      seen.add(id);
      const seenCount = (this.seenCounts.get(id) ?? 0) + 1;
      this.seenCounts.set(id, seenCount);
      if (isPidFallback(providerInstanceId) && seenCount < 2) continue;
      const existing = this.cache.get(id);
      this.cache.set(id, {
        id,
        provider: this.type,
        providerInstanceId,
        name: existing?.name ?? codexName(providerInstanceId, row.pid),
        cwd: codexCwd(group.rows),
        pid: row.pid,
        status: 'running',
        task: existing?.task,
        currentTool: existing?.currentTool,
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
        metadata: {
          command: row.command,
          pids: group.rows.map((item) => item.pid),
          stats: group.rows.map((item) => item.stat).filter(Boolean),
          processCount: group.rows.length
        }
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

function isCodexCliProcess(command: string): boolean {
  if (/agent-monitor/i.test(command)) return false;
  if (/^\S*node\s+\S*\/bin\/codex(\s|$)/.test(command)) return true;
  if (/^\S*\/bin\/codex(\s|$)/.test(command)) return true;
  return /^codex(\s|$)/.test(command);
}

function isStoppedProcess(row: ProcessRow): boolean {
  return typeof row.stat === 'string' && row.stat.startsWith('T');
}

interface CodexProcessGroup {
  providerInstanceId: string;
  representative: ProcessRow;
  rows: ProcessRow[];
}

function groupCodexRows(rows: ProcessRow[]): CodexProcessGroup[] {
  const groups = new Map<string, ProcessRow[]>();
  for (const row of rows) {
    const key = codexInstanceId(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].map(([providerInstanceId, groupRows]) => ({
    providerInstanceId,
    rows: groupRows.sort((a, b) => a.pid - b.pid),
    representative: representativeCodexRow(groupRows)
  }));
}

function codexInstanceId(row: ProcessRow): string {
  const command = row.command;
  const resume = command.match(/\bcodex(?:\.js)?\s+resume\s+([0-9a-f-]{20,})\b/i);
  if (resume) return resume[1];

  const rollout = command.match(/\brollout-\d{4}-.*?([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl\b/i);
  if (rollout) return rollout[1];

  const session = command.match(/\b(?:session|thread|conversation)[_-]?id[=\s:]([0-9a-f-]{20,})\b/i);
  if (session) return session[1];

  return String(row.pid);
}

function representativeCodexRow(rows: ProcessRow[]): ProcessRow {
  return [...rows].sort((a, b) => representativeScore(b) - representativeScore(a) || a.pid - b.pid)[0];
}

function representativeScore(row: ProcessRow): number {
  let score = 0;
  if (/\/vendor\/|codex-linux|codex-[a-z0-9_-]+/i.test(row.command)) score += 3;
  if (/\bcodex(?:\.js)?\s+resume\b/i.test(row.command)) score += 2;
  if (!/^\S*node\b/.test(row.command)) score += 1;
  return score;
}

function codexName(providerInstanceId: string, pid: number): string {
  return providerInstanceId === String(pid) ? `Codex ${pid}` : `Codex ${providerInstanceId.slice(0, 8)}`;
}

function isPidFallback(providerInstanceId: string): boolean {
  return /^\d+$/.test(providerInstanceId);
}

function codexCwd(rows: ProcessRow[]): string | undefined {
  return rows
    .sort((a, b) => cwdScore(b) - cwdScore(a) || a.pid - b.pid)
    .map(processCwd)
    .find((cwd): cwd is string => Boolean(cwd));
}

function cwdScore(row: ProcessRow): number {
  let score = 0;
  if (/^\S*node\s+\S*\/bin\/codex(\s|$)/.test(row.command)) score += 3;
  if (/\bcodex(?:\.js)?\s+resume\b/i.test(row.command)) score += 2;
  if (row.source !== 'windows') score += 1;
  return score;
}

function processCwd(row: ProcessRow): string | undefined {
  if (row.source === 'windows' || row.pid < 1 || process.platform === 'win32') return undefined;
  try {
    return readlinkSync(`/proc/${row.pid}/cwd`);
  } catch {
    return undefined;
  }
}
