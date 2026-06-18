import type { AgentEvent, AgentInstance, AgentProviderType, AgentStatus } from '@agent-monitor/shared';

export interface AgentProvider {
  type: AgentProviderType;
  discover(): Promise<AgentInstance[]>;
  getStatus(id: string): Promise<AgentStatus | undefined>;
  subscribe(onEvent: (event: AgentEvent) => void): Promise<() => void>;
}
