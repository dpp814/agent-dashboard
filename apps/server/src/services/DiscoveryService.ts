import type { AgentStatus } from '@agent-monitor/shared';
import { serverConfig } from '../config.js';
import { AppDatabase } from '../db/Database.js';
import { ClaudeProvider } from '../providers/claude/ClaudeProvider.js';
import { CodexProvider } from '../providers/codex/CodexProvider.js';
import { StateStore } from './StateStore.js';
import { WebSocketHub } from '../ws/WebSocketHub.js';

export class DiscoveryService {
  private timer: NodeJS.Timeout | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private providers = [new ClaudeProvider(), new CodexProvider()];

  constructor(
    private store: StateStore,
    private db: AppDatabase,
    private ws: WebSocketHub
  ) {}

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), serverConfig.pollMs);
    this.cleanupOldRows();
    this.cleanupTimer = setInterval(() => this.cleanupOldRows(), 60 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  private async poll(): Promise<void> {
    for (const provider of this.providers) {
      try {
        const agents = await provider.discover();
        const seenIds = new Set<string>();
        let changedAny = false;
        for (const agent of agents as AgentStatus[]) {
          seenIds.add(agent.id);
          const { agent: updated, changed } = this.store.upsertDiscovered(agent);
          if (changed) changedAny = true;
        }
        if (this.store.markProviderMissing(provider.type, seenIds).length) changedAny = true;
        if (changedAny) this.ws.broadcast({ type: 'snapshot', payload: this.store.snapshot() });
      } catch (error) {
        this.ws.broadcast({
          type: 'error',
          payload: { message: `${provider.type} discovery failed: ${error instanceof Error ? error.message : String(error)}` }
        });
      }
    }
  }

  private cleanupOldRows(): void {
    const cutoff = new Date(Date.now() - serverConfig.historyDays * 24 * 60 * 60 * 1000).toISOString();
    this.db.cleanupHistory(cutoff);
    this.db.cleanupEvents(cutoff);
    this.db.cleanupResolvedApprovals(cutoff);
  }
}
