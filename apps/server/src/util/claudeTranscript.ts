import { readFileSync } from 'node:fs';

export interface TranscriptTaskStart {
  startedAt: string;
  task: string;
}

export function taskStartFromTranscriptFile(path: string, beforeTs?: string): TranscriptTaskStart | undefined {
  const cutoff = beforeTs ? Date.parse(beforeTs) : undefined;
  const hasCutoff = typeof cutoff === 'number' && Number.isFinite(cutoff);
  try {
    const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      const row = JSON.parse(line) as Record<string, unknown>;
      const rowTs = Date.parse(String(row.timestamp ?? ''));
      if (hasCutoff && Number.isFinite(rowTs) && rowTs > cutoff) continue;
      const task = typedPromptText(row);
      if (task) return { startedAt: Number.isFinite(rowTs) ? String(row.timestamp) : beforeTs ?? new Date().toISOString(), task };
    }
  } catch {
    return undefined;
  }
}

function typedPromptText(row: Record<string, unknown>): string | undefined {
  if (row.type !== 'user' || row.isMeta === true || row.isSidechain === true) return undefined;
  const text = userMessageText(row.message);
  if (!text) return undefined;
  if (row.promptSource === 'typed') return text;
  return commandPromptText(text);
}

function commandPromptText(text: string): string | undefined {
  const name = text.match(/<command-name>([\s\S]*?)<\/command-name>/)?.[1]?.trim();
  if (!name) return undefined;
  const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
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
