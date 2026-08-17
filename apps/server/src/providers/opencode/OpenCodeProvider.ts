import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, AgentInstance, AgentStatus } from '@agent-monitor/shared';
import type { AgentProvider } from '../AgentProvider.js';
import { stableId } from '../../util/ids.js';

interface OpenCodeSession {
  id: string;
  title: string;
  directory: string;
  time_created: number;
  time_updated: number;
  tokens_input: number;
  tokens_output: number;
  model: string;
}

export class OpenCodeProvider implements AgentProvider {
  readonly type = 'opencode' as const;
  private dbPath: string;
  private db?: DatabaseSync;

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
        this.db = new DatabaseSync(this.dbPath);
      } catch (error) {
        console.error('Failed to open OpenCode database:', error);
        return undefined;
      }
    }
    return this.db;
  }

  async discover(): Promise<AgentInstance[]> {
    // OpenCode 是纯历史模式，不参与 agent 状态管理
    // 历史数据由 syncOpenCodeHistory 单独写入
    return [];
  }

  async getStatus(id: string): Promise<AgentStatus | undefined> {
    // OpenCode 都是历史记录，状态不会变化
    return undefined;
  }

  async subscribe(): Promise<() => void> {
    // OpenCode 纯历史模式，不支持实时订阅
    return () => {};
  }

  // 供外部调用，获取所有会话（用于历史同步）
  getActiveSessions(): OpenCodeSession[] {
    const db = this.getDatabase();
    if (!db) return [];

    try {
      const sessions = db.prepare(`
        SELECT id, title, directory, time_created, time_updated,
               tokens_input, tokens_output, model
        FROM session
        ORDER BY time_updated DESC
        LIMIT 100
      `).all();
      return sessions as unknown as OpenCodeSession[];
    } catch (error) {
      console.error('Failed to get OpenCode sessions:', error);
      return [];
    }
  }

  // 获取会话的所有消息
  getSessionMessages(sessionId: string): Array<{ role: string; content: string; timestamp: number }> {
    const db = this.getDatabase();
    if (!db) return [];

    try {
      const messages = db.prepare(`
        SELECT id, data, time_created
        FROM message
        WHERE session_id = ?
        ORDER BY time_created ASC
      `).all(sessionId) as Array<{ id: string; data: string; time_created: number }>;

      return messages.map(msg => {
        const data = JSON.parse(msg.data);
        return {
          role: data.role,
          content: this.extractMessageContent(msg.id),
          timestamp: msg.time_created
        };
      });
    } catch (error) {
      console.error('Failed to get session messages:', error);
      return [];
    }
  }

  private extractMessageContent(messageId: string): string {
    const db = this.getDatabase();
    if (!db) return '';

    try {
      const parts = db.prepare(`
        SELECT data
        FROM part
        WHERE message_id = ?
        ORDER BY time_created ASC
      `).all(messageId) as Array<{ data: string }>;

      const textParts = parts
        .map(p => JSON.parse(p.data))
        .filter(p => p.type === 'text')
        .map(p => p.text || '')
        .filter(Boolean);

      return textParts.join('\n');
    } catch (error) {
      return '';
    }
  }

  private sessionToInstance(session: OpenCodeSession): AgentInstance {
    const providerInstanceId = session.id;
    const agentId = stableId('opencode', providerInstanceId);

    return {
      id: agentId,
      provider: 'opencode',
      providerInstanceId,
      name: session.title || `OpenCode ${session.id.slice(0, 8)}`,
      cwd: session.directory,
      startedAt: new Date(session.time_created).toISOString(),
      metadata: {
        model: session.model,
        tokensInput: session.tokens_input,
        tokensOutput: session.tokens_output,
        updatedAt: new Date(session.time_updated).toISOString()
      }
    };
  }
}
