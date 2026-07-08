import type { ApprovalRequest, DashboardSnapshot, HistoryProviderFilter, WsMessage } from '@agent-monitor/shared';

const apiBase = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8787';
const wsBase = apiBase.replace(/^http/, 'ws');
const token = import.meta.env.VITE_AGENT_MONITOR_TOKEN ?? '';

const authHeaders = token ? { authorization: `Bearer ${token}` } : undefined;

export async function fetchSnapshot(search = '', limit = 50, offset = 0, provider: HistoryProviderFilter = 'all'): Promise<DashboardSnapshot> {
  const params = new URLSearchParams({
    search,
    limit: String(limit),
    offset: String(offset),
    provider
  });
  const response = await fetch(`${apiBase}/api/snapshot?${params.toString()}`, { headers: authHeaders });
  if (!response.ok) throw new Error(`Snapshot failed: ${response.status}`);
  return response.json();
}

export type { HistoryProviderFilter };

export async function resolveApproval(id: string, action: 'approve' | 'reject'): Promise<ApprovalRequest> {
  const response = await fetch(`${apiBase}/api/approvals/${id}/${action}`, { method: 'POST', headers: authHeaders });
  if (!response.ok) throw new Error(`Approval update failed: ${response.status}`);
  return response.json();
}

export function connectWs(onMessage: (message: WsMessage) => void, onStatus: (connected: boolean) => void): () => void {
  let closed = false;
  let socket: WebSocket | undefined;
  let retry: number | undefined;

  const connect = () => {
    const wsUrl = new URL('/ws', wsBase);
    if (token) wsUrl.searchParams.set('token', token);
    socket = new WebSocket(wsUrl.toString());
    socket.onopen = () => onStatus(true);
    socket.onclose = () => {
      onStatus(false);
      if (!closed) retry = window.setTimeout(connect, 1500);
    };
    socket.onerror = () => onStatus(false);
    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(event.data) as WsMessage);
      } catch {
        // Ignore malformed frames and keep the live connection open.
      }
    };
  };

  connect();

  return () => {
    closed = true;
    if (retry) window.clearTimeout(retry);
    socket?.close();
  };
}
