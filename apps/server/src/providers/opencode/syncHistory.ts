import type { AgentEvent, TaskHistory } from '@agent-monitor/shared';
import type { AppDatabase } from '../../db/Database.js';
import type { OpenCodeMessage, OpenCodeProvider } from './OpenCodeProvider.js';
import { stableId } from '../../util/ids.js';
import { cleanTaskText } from '../../util/taskText.js';
import { serverConfig } from '../../config.js';

const syncState = {
  processedSessions: new Map<string, number>()
};

interface CompletedTurn {
  task: string;
  result: string;
  startedAt: number;
  endedAt: number;
}

interface TurnSlice {
  user: OpenCodeMessage;
  messages: OpenCodeMessage[];
}

export interface OpenCodeHistorySync {
  upserted: TaskHistory[];
}

// 返回新增/更新的历史卷宗（供调用方广播，让前端无需手动刷新）
export function syncOpenCodeHistory(provider: OpenCodeProvider, db: AppDatabase): OpenCodeHistorySync {
  const result: OpenCodeHistorySync = { upserted: [] };
  try {
    const sessions = provider.getActiveSessions();
    if (!sessions || sessions.length === 0) return result;

    const liveIds = provider.getLiveSessionIds();
    const cutoff = serverConfig.historyDays > 0
      ? Date.now() - serverConfig.historyDays * 24 * 60 * 60 * 1000
      : undefined;

    for (const session of sessions) {
      const isLive = liveIds.has(session.id);
      // 死会话在更新时间不变时无需重扫；活会话每轮都扫，以捕获新完成的问答回合
      if (!isLive) {
        if (syncState.processedSessions.get(session.id) === session.time_updated) {
          continue;
        }
      }

      const messages = provider.getSessionMessages(session.id);
      if (!isLive) syncState.processedSessions.set(session.id, session.time_updated);
      if (!messages || messages.length === 0) {
        continue;
      }

      const agentId = stableId('opencode', session.id);

      // 升级前旧代码按「整个会话一条」写过汇总卷宗；首个回合复用该行，保留收藏和记录 ID
      const sessionCreatedIso = new Date(session.time_created).toISOString();
      let legacyHistory = db.getHistoryByProviderInstance(session.id)
        .find((row) => row.startedAt === sessionCreatedIso);

      const turns = completedTurns(messages);
      // 进程已退出的会话：末尾若还有提问但回复未完成（被打断/中途关闭），补记一条以免丢记录
      if (!isLive) {
        const trailing = trailingIncompleteTurn(messages, session);
        if (trailing) turns.push(trailing);
      }

      for (const turn of turns) {
        if (cutoff !== undefined && turn.endedAt < cutoff) continue;
        const startedAt = new Date(turn.startedAt).toISOString();
        const endedAt = new Date(turn.endedAt).toISOString();
        const task = cleanTaskText(turn.task);
        const resultSummary = turn.result.trim() || undefined;
        if (!task && !resultSummary) {
          continue;
        }

        // 同一起点可能被旧逻辑提前记过一条；原地更新以保留收藏和记录 ID
        const turnHistory = db.findHistoryByTaskStart(agentId, startedAt);
        const existing = turnHistory ?? legacyHistory;
        legacyHistory = undefined;
        if (!existing && db.hasSyncedProviderHistoryTurn('opencode', session.id, startedAt)) {
          continue;
        }
        const historyRow = {
          agentId,
          provider: 'opencode' as const,
          providerInstanceId: session.id,
          task,
          startedAt,
          endedAt,
          durationMs: completionDurationMs(turn.startedAt, turn.endedAt),
          finalStatus: 'finished' as const,
          resultSummary
        };
        if (existing) {
          db.markProviderHistoryTurnSynced('opencode', session.id, startedAt);
          if (existing.startedAt === startedAt && existing.endedAt === endedAt &&
              existing.task === task && existing.resultSummary === resultSummary) {
            continue;
          }
          if (existing.endedAt) db.deleteCompletionEvents(agentId, session.id, existing.endedAt);
          const updated = db.updateHistory(existing.id, historyRow);
          db.insertEventIfMissing(startEvent(agentId, session, task, startedAt));
          db.insertEventIfMissing(messageEvent(agentId, session, 'user_message', turn.task, startedAt));
          db.insertEventIfMissing(messageEvent(agentId, session, 'assistant_response', turn.result, endedAt));
          db.insertEventIfMissing(finishEvent(agentId, session, task, resultSummary, endedAt));
          result.upserted.push(updated);
          continue;
        }

        if (db.hasHistoryForCompletion(agentId, endedAt)) continue;
        const inserted = db.insertHistory(historyRow);
        db.markProviderHistoryTurnSynced('opencode', session.id, startedAt);

        db.insertEventIfMissing(startEvent(agentId, session, task, startedAt));
        db.insertEventIfMissing(messageEvent(agentId, session, 'user_message', turn.task, startedAt));
        db.insertEventIfMissing(messageEvent(agentId, session, 'assistant_response', turn.result, endedAt));
        db.insertEventIfMissing(finishEvent(agentId, session, task, resultSummary, endedAt));
        result.upserted.push(inserted);
      }
    }

    return result;
  } catch (error) {
    console.error('Failed to sync OpenCode history:', error);
    return result;
  }
}

// 把消息流按「一条用户提问 → 其后所有助手消息」切成一轮轮问答
function turnSlices(messages: OpenCodeMessage[]): TurnSlice[] {
  const slices: TurnSlice[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message.role === 'user' && message.content.trim()) {
      const start = i + 1;
      let j = start;
      while (j < messages.length && !(messages[j].role === 'user' && messages[j].content.trim())) {
        j++;
      }
      slices.push({ user: message, messages: messages.slice(start, j) });
      i = j;
    } else {
      i++;
    }
  }
  return slices;
}

// 一轮问答完成 = 该轮最后一条消息是已完成的助手消息（time.completed 存在），
// 结果为该轮所有助手消息文本的拼接
function completedTurns(messages: OpenCodeMessage[]): CompletedTurn[] {
  const turns: CompletedTurn[] = [];
  for (const slice of turnSlices(messages)) {
    const last = slice.messages[slice.messages.length - 1];
    if (!last || last.role !== 'assistant' || !last.completed) continue;
    turns.push({
      task: slice.user.content.trim(),
      result: assistantText(slice.messages),
      startedAt: slice.user.timestamp,
      endedAt: last.completed
    });
  }
  return turns;
}

// 进程已退出时，末尾提问若无完整回复则视为一次被打断的回合，仍记入历史
function trailingIncompleteTurn(messages: OpenCodeMessage[], session: { time_updated: number }): CompletedTurn | undefined {
  const slices = turnSlices(messages);
  const lastSlice = slices[slices.length - 1];
  if (!lastSlice) return undefined;

  const last = lastSlice.messages[lastSlice.messages.length - 1];
  // 已有完整回复时该回合已由 completedTurns 记录
  if (last && last.role === 'assistant' && last.completed) return undefined;

  const lastMessageTs = lastSlice.messages.reduce((max, message) => Math.max(max, message.timestamp), lastSlice.user.timestamp);
  return {
    task: lastSlice.user.content.trim(),
    result: assistantText(lastSlice.messages),
    startedAt: lastSlice.user.timestamp,
    endedAt: Math.max(lastMessageTs, session.time_updated)
  };
}

function assistantText(messages: OpenCodeMessage[]): string {
  return messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join('\n');
}

function startEvent(agentId: string, session: OpenCodeSessionLike, task: string | undefined, ts: string): AgentEvent {
  return {
    type: 'started',
    agentId,
    provider: 'opencode',
    providerInstanceId: session.id,
    ts,
    payload: {
      task,
      model: session.model,
      directory: session.directory
    }
  };
}

function messageEvent(agentId: string, session: OpenCodeSessionLike, toolName: string, message: string, ts: string): AgentEvent {
  return {
    type: 'tool_finished',
    agentId,
    provider: 'opencode',
    providerInstanceId: session.id,
    ts,
    payload: {
      tool_name: toolName,
      message
    }
  };
}

function finishEvent(agentId: string, session: OpenCodeSessionLike, task: string | undefined, result: string | undefined, ts: string): AgentEvent {
  return {
    type: 'finished',
    agentId,
    provider: 'opencode',
    providerInstanceId: session.id,
    ts,
    payload: {
      task,
      result,
      tokensInput: session.tokens_input,
      tokensOutput: session.tokens_output
    }
  };
}

type OpenCodeSessionLike = {
  id: string;
  directory: string;
  model: string;
  tokens_input: number;
  tokens_output: number;
};

function completionDurationMs(startedAt: number, endedAt: number): number | undefined {
  const duration = endedAt - startedAt;
  return duration >= 0 ? duration : undefined;
}
