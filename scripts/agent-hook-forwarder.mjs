#!/usr/bin/env node
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const provider = process.argv[2];
const endpoint = process.argv[3];

if (!provider || !endpoint) {
  process.stderr.write('Usage: agent-hook-forwarder <provider> <endpoint>\n');
  process.exit(1);
}

const chunks = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.from(chunk));
}

const raw = Buffer.concat(chunks).toString('utf8') || '{}';
let payload;
try {
  payload = JSON.parse(raw);
} catch {
  payload = { raw };
}

payload.__agent_monitor = {
  provider,
  received_at: new Date().toISOString()
};

// Grok loads Claude Code's ~/.claude/settings.json hooks too, so it fires this
// forwarder as "claude". Drop those — grok events arrive via its native hook.
if (provider === 'claude' && process.env.GROK_HOOK_EVENT) {
  process.exit(0);
}

const body = JSON.stringify(payload);
const url = new URL(endpoint);
const token = url.searchParams.get('token') || process.env.AGENT_MONITOR_TOKEN || '';
const hookEventName = String(payload.hook_event_name ?? payload.hookEventName ?? payload.type ?? '');
const isBlockingApproval =
  (provider === 'claude' && hookEventName === 'PermissionRequest') ||
  (provider === 'grok' && hookEventName === 'pre_tool_use');

const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
const req = request({
  method: 'POST',
  hostname: url.hostname,
  port: url.port || (url.protocol === 'https:' ? 443 : 80),
  path: `${url.pathname}${url.search}`,
  headers: {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...(token ? { authorization: `Bearer ${token}` } : {})
  },
  timeout: isBlockingApproval ? 590_000 : 1500
}, (res) => {
  const responseChunks = [];
  res.on('data', (chunk) => responseChunks.push(Buffer.from(chunk)));
  res.on('end', () => {
    if (res.statusCode && res.statusCode >= 500) process.exit(1);

    const rawResponse = Buffer.concat(responseChunks).toString('utf8');
    if (rawResponse) {
      try {
        const responseJson = JSON.parse(rawResponse);
        // Claude wraps its decision in hookSpecificOutput; grok returns a top-level decision.
        if (responseJson?.hookSpecificOutput || responseJson?.decision) {
          process.stdout.write(`${JSON.stringify(responseJson)}\n`);
        }
      } catch {
        // Non-JSON responses are telemetry acknowledgements, not hook decisions.
      }
    }

    process.exit(0);
  });
});

req.on('error', (error) => {
  process.stderr.write(`agent-monitor hook forward failed: ${error.message}\n`);
  process.exit(0);
});

req.on('timeout', () => {
  req.destroy();
  process.exit(0);
});

req.end(body);
