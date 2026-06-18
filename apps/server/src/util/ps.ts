import { commandExists, execFileText } from './exec.js';

const WINDOWS_PROCESS_CACHE_MS = Number(process.env.AGENT_MONITOR_WINDOWS_PS_CACHE_MS ?? 10_000);
let windowsProcessCache: { expiresAt: number; rows: ProcessRow[] } | undefined;

export interface ProcessRow {
  pid: number;
  ppid: number;
  stat?: string;
  command: string;
  source?: 'linux' | 'windows';
}

export async function listProcesses(): Promise<ProcessRow[]> {
  if (process.platform === 'win32') {
    return listWindowsProcesses();
  }

  const raw = await execFileText('ps', ['-eo', 'pid=,ppid=,stat=,args='], 5000);
  const linuxRows = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): ProcessRow | undefined => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), stat: match[3], command: match[4], source: 'linux' as const } : undefined;
    })
    .filter((row): row is ProcessRow => Boolean(row));
  return process.env.AGENT_MONITOR_WINDOWS_PS === '0'
    ? linuxRows
    : [...linuxRows, ...await listWindowsProcessesFromWsl()];
}

async function listWindowsProcessesFromWsl(): Promise<ProcessRow[]> {
  if (windowsProcessCache && windowsProcessCache.expiresAt > Date.now()) return windowsProcessCache.rows;
  const shells = [];
  for (const command of ['powershell.exe', 'pwsh.exe']) {
    if (await commandExists(command)) shells.push(command);
  }
  for (const command of shells) {
    try {
      const rows = await listWindowsProcesses(command);
      windowsProcessCache = { rows, expiresAt: Date.now() + WINDOWS_PROCESS_CACHE_MS };
      return rows;
    } catch {
      // Try the next Windows shell.
    }
  }
  windowsProcessCache = { rows: [], expiresAt: Date.now() + WINDOWS_PROCESS_CACHE_MS };
  return [];
}

async function listWindowsProcesses(shell = 'powershell'): Promise<ProcessRow[]> {
  try {
    const raw = await execFileText(shell, [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress'
    ], 8000);
    const parsed = JSON.parse(raw || '[]') as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.map((item): ProcessRow | undefined => {
      const row = item as Record<string, unknown>;
      const pid = Number(row.ProcessId);
      const ppid = Number(row.ParentProcessId);
      const commandLine = String(row.CommandLine ?? '').trim();
      return Number.isFinite(pid) && commandLine
        ? { pid, ppid, command: commandLine, source: 'windows' as const }
        : undefined;
    }).filter((row): row is ProcessRow => Boolean(row));
  } catch {
    if (process.platform !== 'win32') return [];
    const raw = await execFileText('wmic', ['process', 'get', 'ParentProcessId,ProcessId,CommandLine', '/FORMAT:CSV'], 5000);
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(1)
      .map((line): ProcessRow => {
        const parts = line.split(',');
        const pid = Number(parts.at(-1));
        const ppid = Number(parts.at(-2));
        return { pid, ppid, command: parts.slice(1, -2).join(','), source: 'windows' as const };
      })
      .filter((row): row is ProcessRow => Number.isFinite(row.pid) && row.command.length > 0);
  }
}
