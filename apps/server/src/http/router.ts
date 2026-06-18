import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { serverConfig } from '../config.js';
import { StateStore, eventFromHook } from '../services/StateStore.js';
import { WebSocketHub } from '../ws/WebSocketHub.js';

const publicDir = join(fileURLToPath(new URL('../../../web/dist', import.meta.url)));

export function createRouter(store: StateStore, ws: WebSocketHub) {
  return async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/api/snapshot') {
        if (!authorized(req, url)) {
          json(res, { error: 'unauthorized' }, 401);
          return;
        }
        json(res, store.snapshot(
          url.searchParams.get('search') ?? '',
          Number(url.searchParams.get('limit') ?? 50),
          Number(url.searchParams.get('offset') ?? 0)
        ));
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/hooks/')) {
        if (!authorized(req, url)) {
          json(res, { error: 'unauthorized' }, 401);
          return;
        }
        const provider = hookProvider(url.pathname);
        if (!provider) {
          json(res, { error: 'unknown hook provider' }, 404);
          return;
        }
        const body = await readJson(req);
        const result = store.applyEvent(eventFromHook(provider, body));
        const approvalPromise = provider === 'claude' && isPermissionRequest(body) && result.approval
          ? store.waitForApproval(result.approval.id, approvalTimeoutMs())
          : undefined;
        ws.broadcast({ type: 'snapshot', payload: store.snapshot() });
        ws.broadcast({ type: 'agent', payload: result.agent });
        if (result.approval) ws.broadcast({ type: 'approval', payload: result.approval });
        if (result.history) ws.broadcast({ type: 'history', payload: result.history });
        if (approvalPromise && result.approval) {
          let done = false;
          const expireOnClose = () => {
            if (done || !result.approval) return;
            const expired = store.resolveApproval(result.approval.id, 'expired');
            if (expired) ws.broadcast({ type: 'approval', payload: expired });
          };
          res.on('close', expireOnClose);
          const approval = await approvalPromise;
          done = true;
          res.off('close', expireOnClose);
          if (approval?.status === 'expired') ws.broadcast({ type: 'approval', payload: approval });
          if (res.destroyed) return;
          json(res, claudePermissionDecision(toDecisionStatus(approval?.status)));
          return;
        }
        json(res, { ok: true });
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/approvals/')) {
        if (!authorized(req, url)) {
          json(res, { error: 'unauthorized' }, 401);
          return;
        }
        const parts = url.pathname.split('/');
        const id = parts[3];
        const action = parts[4];
        if (!id || (action !== 'approve' && action !== 'reject')) {
          json(res, { error: 'invalid approval action' }, 400);
          return;
        }
        const approval = store.resolveApproval(id, action === 'approve' ? 'approved' : 'rejected');
        if (!approval) {
          json(res, { error: 'approval not found' }, 404);
          return;
        }
        console.log(`Approval ${action}: ${id} from ${req.socket.remoteAddress ?? 'unknown'}`);
        ws.broadcast({ type: 'approval', payload: approval });
        json(res, approval);
        return;
      }

      if (req.method === 'GET') {
        await serveStatic(url.pathname, res);
        return;
      }

      json(res, { error: 'not found' }, 404);
    } catch (error) {
      json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  };
}

export function authorizedRequest(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  return authorized(req, url);
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': 'http://127.0.0.1:5173'
  });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage, url: URL): boolean {
  if (!serverConfig.token) return true;
  const header = req.headers.authorization;
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  return bearer === serverConfig.token || url.searchParams.get('token') === serverConfig.token;
}

function hookProvider(pathname: string): 'claude' | 'codex' | undefined {
  if (pathname === '/api/hooks/claude') return 'claude';
  if (pathname === '/api/hooks/codex') return 'codex';
  return undefined;
}

function isPermissionRequest(body: Record<string, unknown>): boolean {
  return String(body.hook_event_name ?? body.hookEventName ?? body.type ?? '') === 'PermissionRequest';
}

function approvalTimeoutMs(): number {
  return Number(process.env.AGENT_MONITOR_APPROVAL_TIMEOUT_MS ?? 570_000);
}

function claudePermissionDecision(status: ApprovalStatus): Record<string, unknown> {
  const behavior = status === 'approved' ? 'allow' : 'deny';
  const decision: Record<string, unknown> = { behavior };
  if (behavior === 'deny') {
    decision.message = status === 'expired' ? 'Approval timed out in Agent Monitor' : 'Rejected in Agent Monitor';
    decision.interrupt = true;
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision
    }
  };
}

type ApprovalStatus = 'approved' | 'rejected' | 'expired';

function toDecisionStatus(status: unknown): ApprovalStatus {
  return status === 'approved' || status === 'rejected' || status === 'expired' ? status : 'expired';
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(publicDir, requested));
  if (!insidePublicDir(filePath) || !existsSync(filePath)) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'content-type': contentType(filePath) });
  createReadStream(filePath).pipe(res);
}

function insidePublicDir(filePath: string): boolean {
  return filePath === publicDir || filePath.startsWith(`${publicDir}${sep}`);
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    default: return 'application/octet-stream';
  }
}
