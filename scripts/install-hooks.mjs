#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const forwarder = join(root, 'scripts', 'agent-hook-forwarder.mjs');
const uninstall = process.argv.includes('--uninstall');
const port = process.env.AGENT_MONITOR_PORT || '8787';
const host = process.env.AGENT_MONITOR_HOST || '127.0.0.1';
const baseUrl = process.env.AGENT_MONITOR_URL || `http://${host}:${port}`;
const token = process.env.AGENT_MONITOR_TOKEN || '';

chmodSync(forwarder, 0o755);

const claudeFile = join(homedir(), '.claude', 'settings.json');
const codexFile = join(homedir(), '.codex', 'hooks.json');

if (uninstall) {
  uninstallClaude(claudeFile);
  uninstallCodex(codexFile);
  console.log('Agent Monitor hooks removed');
} else {
  installClaude(claudeFile);
  installCodex(codexFile);
  console.log(`Agent Monitor hooks installed for ${baseUrl}`);
}

function installClaude(file) {
  const config = readJson(file);
  config.hooks ??= {};
  for (const event of ['PermissionRequest', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SessionEnd']) {
    config.hooks[event] = withoutMonitor(config.hooks[event] ?? []);
    config.hooks[event].push({
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `node ${JSON.stringify(forwarder)} claude ${JSON.stringify(hookUrl('claude'))}`,
        timeout: event === 'PermissionRequest' ? 600 : 5
      }]
    });
  }
  writeJson(file, config);
}

function uninstallClaude(file) {
  if (!existsSync(file)) return;
  const config = readJson(file);
  if (!config.hooks) return;
  for (const event of Object.keys(config.hooks)) {
    config.hooks[event] = withoutMonitor(config.hooks[event]);
    if (Array.isArray(config.hooks[event]) && config.hooks[event].length === 0) {
      delete config.hooks[event];
    }
  }
  writeJson(file, config);
}

function installCodex(file) {
  const config = readJson(file);
  config.hooks ??= {};
  for (const event of ['PermissionRequest', 'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop']) {
    config.hooks[event] = withoutMonitor(config.hooks[event] ?? []);
    config.hooks[event].push({
      matcher: '*',
      hooks: [{
        type: 'command',
        command: `node ${JSON.stringify(forwarder)} codex ${JSON.stringify(hookUrl('codex'))}`,
        timeout: 5
      }]
    });
  }
  writeJson(file, config);
}

function uninstallCodex(file) {
  if (!existsSync(file)) return;
  const config = readJson(file);
  if (!config.hooks) return;
  for (const event of Object.keys(config.hooks)) {
    config.hooks[event] = withoutMonitor(config.hooks[event]);
    if (Array.isArray(config.hooks[event]) && config.hooks[event].length === 0) {
      delete config.hooks[event];
    }
  }
  writeJson(file, config);
}

function withoutMonitor(groups) {
  if (!Array.isArray(groups)) return [];
  return groups
    .map((group) => ({
      ...group,
      hooks: Array.isArray(group.hooks)
        ? group.hooks.filter((hook) => !String(hook.command ?? '').includes('agent-hook-forwarder.mjs'))
        : []
    }))
    .filter((group) => group.hooks.length > 0);
}

function hookUrl(provider) {
  const url = new URL(`/api/hooks/${provider}`, baseUrl);
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

function readJson(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    copyFileSync(file, `${file}.agent-monitor.bak`);
  }
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
