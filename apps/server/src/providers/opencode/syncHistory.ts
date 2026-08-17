import type { AgentEvent } from '@agent-monitor/shared';
import type { OpenCodeProvider } from './OpenCodeProvider.js';
import type { StateStore } from '../../services/StateStore.js';
import type { AppDatabase } from '../../db/Database.js';
import { stableId } from '../../util/ids.js';

interface SyncState {
  lastSyncTime: number;
  processedSessions: Set<string>;
}

const syncState: SyncState = {
  lastSyncTime: 0,
  processedSessions: new Set()
};

export function syncOpenCodeHistory(provider: OpenCodeProvider, stateStore: StateStore, db: AppDatabase): void {
  try {
    const sessions = provider.getActiveSessions();
    if (!sessions || sessions.length === 0) return;

    const now = Date.now();


    for (const session of sessions) {
      // 内存层：跳过本次进程已处理的
      if (syncState.processedSessions.has(session.id)) {
        continue;
      }

      // DB 层：跳过已存在历史记录的（防止重启后重复写入）
      if (db.hasHistoryForProviderInstance(session.id)) {
        syncState.processedSessions.add(session.id);
        continue;
      }


      const messages = provider.getSessionMessages(session.id);
      if (!messages || messages.length === 0) {
        syncState.processedSessions.add(session.id);
        continue;
      }

      // ⚠️ 关键：直接使用 session.id 作为 providerInstanceId
      const providerInstanceId = session.id;
      const agentId = stableId('opencode', providerInstanceId);

      // 先标记，防止并发重复处理
      syncState.processedSessions.add(session.id);

      // started 事件
      const firstMessage = messages[0];
      // ⚠️ 使用 session.title 作为任务名，它是 OpenCode 自动生成的简短标题
      // 而不是 firstMessage.content，那可能是很长的用户输入
      const taskForStarted = session.title;
      const startEvent: AgentEvent = {
        type: 'started',
        agentId,
        provider: 'opencode',
        providerInstanceId,
        ts: new Date(session.time_created).toISOString(),
        payload: {
          task: taskForStarted,
          model: session.model,
          directory: session.directory
        }
      };
      stateStore.applyEvent(startEvent);

      // 消息事件
      for (const msg of messages) {
        if (msg.role === 'user') {
          stateStore.applyEvent({
            type: 'tool_finished',
            agentId,
            provider: 'opencode',
            providerInstanceId,
            ts: new Date(msg.timestamp).toISOString(),
            payload: {
              tool_name: 'user_message',  // ⚠️ 匹配 Claude 格式
              message: msg.content        // ⚠️ 匹配 Claude 格式
            }
          });
        } else if (msg.role === 'assistant') {
          stateStore.applyEvent({
            type: 'tool_finished',
            agentId,
            provider: 'opencode',
            providerInstanceId,
            ts: new Date(msg.timestamp).toISOString(),
            payload: {
              tool_name: 'assistant_response',
              message: msg.content
            }
          });
        }
      }

      // finished 事件
      stateStore.applyEvent({
        type: 'finished',
        agentId,
        provider: 'opencode',
        providerInstanceId,
        ts: new Date(session.time_updated).toISOString(),
        payload: {
          task: session.title,
          tokensInput: session.tokens_input,
          tokensOutput: session.tokens_output
        }
      });
    }

    syncState.lastSyncTime = now;
  } catch (error) {
    console.error('Failed to sync OpenCode history:', error);
  }
}

// 定期清理内存 Set，防止内存泄漏（超过 1000 条清空）
export function cleanupSyncState(): void {
  if (syncState.processedSessions.size > 1000) {
    syncState.processedSessions.clear();
  }
}
