import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const serverConfig = {
  host: process.env.AGENT_MONITOR_HOST ?? '127.0.0.1',
  port: Number(process.env.AGENT_MONITOR_PORT ?? 8787),
  token: process.env.AGENT_MONITOR_TOKEN ?? '',
  dataDir: process.env.AGENT_MONITOR_DATA_DIR ?? join(process.cwd(), '.agent-monitor'),
  pollMs: Number(process.env.AGENT_MONITOR_POLL_MS ?? 2500),
  historyDays: Number(process.env.AGENT_MONITOR_HISTORY_DAYS ?? 14)
};

mkdirSync(serverConfig.dataDir, { recursive: true });
