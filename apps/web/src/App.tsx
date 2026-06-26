import { useEffect, useMemo, useRef, useState } from 'react';
import { Bell, Check, Clock, Eye, Flame, Moon, Play, Search, ShieldAlert, Sparkles, Sun, Terminal, X } from 'lucide-react';
import type { AgentState, AgentStatus, ApprovalRequest, DashboardSnapshot, TaskHistory, WsMessage } from '@agent-monitor/shared';
import { connectWs, fetchSnapshot, resolveApproval } from './api';

type NotificationPermissionState = NotificationPermission | 'unsupported';
type ThemeMode = 'day' | 'night' | 'eye';
type NotificationIconUsage = {
  name: string;
  path: string;
  count: number;
};
type CultivationLevel = {
  label: string;
  className: string;
  rankIndex: number;
  progress: number;
  nextBreakthroughIn: number;
  breakthrough: boolean;
  showBreakthroughLabel: boolean;
};

const emptySnapshot: DashboardSnapshot = {
  agents: [],
  approvals: [],
  history: [],
  updatedAt: new Date().toISOString()
};

const historyPageSize = 50;
const themeStorageKey = 'agent-monitor-theme';
const themeModes: ThemeMode[] = ['day', 'night', 'eye'];
const transientApprovalMs = 5000;
const notifiedAgentEventKeys = new Set<string>();
const notificationIconUsageStorageKey = 'agent-monitor-notification-icon-usage';
const notificationIconUsageEvent = 'agent-monitor-notification-icon-usage-change';
const cultivationRanks = ['炼气', '筑基', '结丹', '元婴', '化神', '炼虚', '合体', '大乘', '真仙', '金仙', '太乙', '大罗', '道祖'];
const notificationIconPaths = [
  '/notification-icon/hanli.png',
  '/notification-icon/mupeiling.png',
  '/notification-icon/nangongwan.png',
  '/notification-icon/songyu.png',
  '/notification-icon/yinyue.png',
  '/notification-icon/yuanyao.png',
  '/notification-icon/ziling.png'
];

export function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(emptySnapshot);
  const [connected, setConnected] = useState(false);
  const [search, setSearch] = useState('');
  const [historyPage, setHistoryPage] = useState(0);
  const [error, setError] = useState<string>();
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>(() => notificationState());
  const [notificationIconUsage, setNotificationIconUsage] = useState<NotificationIconUsage[]>(() => readNotificationIconUsage());
  const [previewIcon, setPreviewIcon] = useState<NotificationIconUsage>();
  const [theme, setTheme] = useState<ThemeMode>(() => initialTheme());
  const [hiddenApprovalIds, setHiddenApprovalIds] = useState<Set<string>>(() => new Set());
  const notifiedApprovalIds = useRef(new Set<string>());
  const transientApprovalTimers = useRef(new Map<string, number>());
  const historyQuery = useRef({ search: '', page: 0 });
  const visibleApprovals = useMemo(
    () => snapshot.approvals.filter((approval) => !hiddenApprovalIds.has(approval.id)),
    [snapshot.approvals, hiddenApprovalIds]
  );
  const actionableApprovals = useMemo(() => visibleApprovals.filter(isActionableApproval), [visibleApprovals]);
  const visibleAgents = useMemo(
    () => agentsOutsideApprovalCenter(snapshot.agents, actionableApprovals),
    [snapshot.agents, actionableApprovals]
  );

  useEffect(() => {
    fetchSnapshot('', historyPageSize, 0).then(normalizeSnapshot).then(setSnapshot).catch((err: Error) => setError(err.message));
    return connectWs(handleWsMessage, setConnected);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    const onUsageChange = () => setNotificationIconUsage(readNotificationIconUsage());
    window.addEventListener(notificationIconUsageEvent, onUsageChange);
    window.addEventListener('storage', onUsageChange);
    return () => {
      window.removeEventListener(notificationIconUsageEvent, onUsageChange);
      window.removeEventListener('storage', onUsageChange);
    };
  }, []);

  useEffect(() => {
    if (!previewIcon) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPreviewIcon(undefined);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewIcon]);

  useEffect(() => {
    historyQuery.current = { search, page: historyPage };
    const timer = window.setTimeout(() => {
      fetchSnapshot(search, historyPageSize, historyPage * historyPageSize)
        .then((next) => setSnapshot((current) => ({ ...current, history: next.history })))
        .catch(() => {});
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, historyPage]);

  useEffect(() => {
    const pendingIds = new Set(snapshot.approvals.map((approval) => approval.id));
    for (const [id, timer] of transientApprovalTimers.current) {
      if (!pendingIds.has(id)) {
        window.clearTimeout(timer);
        transientApprovalTimers.current.delete(id);
      }
    }

    for (const approval of snapshot.approvals) {
      if (approval.provider !== 'codex' || hiddenApprovalIds.has(approval.id) || transientApprovalTimers.current.has(approval.id)) continue;
      const timer = window.setTimeout(() => {
        transientApprovalTimers.current.delete(approval.id);
        setHiddenApprovalIds((current) => new Set(current).add(approval.id));
      }, transientApprovalMs);
      transientApprovalTimers.current.set(approval.id, timer);
    }
  }, [snapshot.approvals, hiddenApprovalIds]);

  useEffect(() => () => {
    for (const timer of transientApprovalTimers.current.values()) window.clearTimeout(timer);
    transientApprovalTimers.current.clear();
  }, []);

  async function onRequestNotifications() {
    if (!('Notification' in window) || Notification.permission === 'denied') return;
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
  }

  function onCycleTheme() {
    setTheme((current) => themeModes[(themeModes.indexOf(current) + 1) % themeModes.length]);
  }

  function revealTransientApproval(id: string) {
    setHiddenApprovalIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    const existing = transientApprovalTimers.current.get(id);
    if (existing) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      transientApprovalTimers.current.delete(id);
      setHiddenApprovalIds((current) => new Set(current).add(id));
    }, transientApprovalMs);
    transientApprovalTimers.current.set(id, timer);
  }

  function handleWsMessage(message: WsMessage) {
    if (message.type === 'snapshot') {
      setSnapshot(normalizeSnapshot(message.payload));
      return;
    }
    if (message.type === 'agent') {
      setSnapshot((current) => ({
        ...current,
        agents: normalizeAgents(upsert(current.agents, message.payload)),
        updatedAt: new Date().toISOString()
      }));
      maybeNotify(message.payload);
      return;
    }
    if (message.type === 'approval') {
      if (message.payload.status === 'pending') {
        setHiddenApprovalIds((current) => {
          if (!current.has(message.payload.id)) return current;
          const next = new Set(current);
          next.delete(message.payload.id);
          return next;
        });
      }
      setSnapshot((current) => ({
        ...current,
        approvals: message.payload.status === 'pending'
          ? upsert(current.approvals, message.payload)
          : current.approvals.filter((item) => item.id !== message.payload.id)
      }));
      if (message.payload.status === 'pending' && !notifiedApprovalIds.current.has(message.payload.id)) {
        notifiedApprovalIds.current.add(message.payload.id);
        notifyApproval(message.payload, message.payload.provider === 'codex' ? () => revealTransientApproval(message.payload.id) : undefined);
      }
      if (message.payload.status !== 'pending') notifiedApprovalIds.current.delete(message.payload.id);
      return;
    }
    if (message.type === 'history') {
      const { search: currentSearch, page } = historyQuery.current;
      maybeNotifyHistory(message.payload);
      if (currentSearch.trim()) {
        fetchSnapshot(currentSearch, historyPageSize, page * historyPageSize)
          .then((next) => setSnapshot((current) => ({ ...current, history: next.history })))
          .catch(() => {});
      } else {
        setSnapshot((current) => ({
          ...current,
          history: page === 0
            ? [message.payload, ...current.history.filter((item) => item.id !== message.payload.id)].slice(0, historyPageSize)
            : current.history
        }));
      }
      return;
    }
    if (message.type === 'error') setError(message.payload.message);
  }

  async function onResolveApproval(approval: ApprovalRequest, action: 'approve' | 'reject') {
    const resolved = await resolveApproval(approval.id, action);
    setSnapshot((current) => ({
      ...current,
      approvals: current.approvals.filter((item) => item.id !== resolved.id),
      agents: current.agents.map((agent) => agent.id === resolved.agentId
        ? {
          ...agent,
          status: resolved.status === 'approved' ? 'running' : 'idle',
          currentTool: undefined,
          waitingFor: undefined,
          approval: resolved,
          updatedAt: resolved.resolvedAt ?? agent.updatedAt
        }
        : agent)
    }));
  }

  const stats = useMemo(() => buildStats(snapshot.agents), [snapshot.agents]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>AI修仙传</h1>
        </div>
        <div className="topbarActions">
          <NotificationButton permission={notificationPermission} onRequest={onRequestNotifications} />
          <ThemeButton theme={theme} onCycle={onCycleTheme} />
          <span className={`connection ${connected ? 'ok' : 'bad'}`}>{connected ? '已出关' : '闭关中'}</span>
        </div>
      </header>

      {error ? <div className="errorBar">{error}</div> : null}

      <section className="stats">
        <Stat label="修行中" value={stats.running} tone="green" />
        <Stat label="候令中" value={stats.waiting} tone="yellow" />
        <Stat label="已圆满" value={stats.finished} tone="blue" />
        <Stat label="生异象" value={stats.error} tone="red" />
      </section>

      <section className="workspace">
        <div className="agentsPanel">
          <div className="sectionHeader">
            <div className="sectionTitle">
              <h2>诸道友</h2>
              <span>{visibleAgents.length}</span>
            </div>
          </div>
          <div className="agentGrid">
            {visibleAgents.length ? visibleAgents.map((agent) => <AgentCard key={agent.id} agent={agent} />) : <EmptyState text="暂无使者" />}
          </div>
        </div>

        <aside className="approvalPanel">
          <div className="sectionHeader">
            <div className="sectionTitle">
              <h2 id="authorization-center">授令阁</h2>
              <span>{visibleApprovals.length}</span>
            </div>
          </div>
          <p className="panelNote">Claude 可在此授令，Codex 只暂现片刻，仍需回命令行应答</p>
          <div className="approvalList">
            {visibleApprovals.length ? visibleApprovals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} onResolve={onResolveApproval} />
            )) : <EmptyState text="暂无待批法旨" compact />}
          </div>
        </aside>
      </section>

      <section className="iconUsagePanel">
        <div className="sectionHeader">
          <div className="sectionTitle">
            <h2>道友图鉴</h2>
            <span>{notificationIconUsage.reduce((total, icon) => total + icon.count, 0)}</span>
          </div>
        </div>
        <NotificationIconUsageList icons={notificationIconUsage} onPreview={setPreviewIcon} />
      </section>

      {previewIcon ? <NotificationIconPreview icon={previewIcon} onClose={() => setPreviewIcon(undefined)} /> : null}

      <section className="historyPanel">
          <div className="sectionHeader">
            <div className="sectionTitle">
              <h2>卷宗</h2>
            </div>
            <div className="historyTools">
              <label className="searchBox">
                <Search size={16} />
                <input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setHistoryPage(0);
                  }}
                  placeholder="查阅卷宗"
                />
              </label>
            </div>
          </div>
        <HistoryTable rows={snapshot.history} />
        <div className="pager historyPager">
          <button disabled={historyPage === 0} onClick={() => setHistoryPage((page) => Math.max(0, page - 1))}>上卷</button>
          <span>第 {historyPage + 1} 页</span>
          <button disabled={snapshot.history.length < historyPageSize} onClick={() => setHistoryPage((page) => page + 1)}>下卷</button>
        </div>
      </section>
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NotificationButton({ permission, onRequest }: { permission: NotificationPermissionState; onRequest: () => void }) {
  const disabled = permission === 'denied' || permission === 'unsupported';
  const title = notificationTitle(permission);
  return (
    <button
      className={`iconButton notificationButton ${permission}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={() => void onRequest()}
    >
      <Bell size={18} />
      <span>{notificationLabel(permission)}</span>
    </button>
  );
}

function ThemeButton({ theme, onCycle }: { theme: ThemeMode; onCycle: () => void }) {
  const title = `界色：${themeLabel(theme)}`;
  return (
    <button className="iconButton themeButton" title={title} aria-label={title} onClick={onCycle}>
      {themeIcon(theme)}
      <span>{themeLabel(theme)}</span>
    </button>
  );
}

function AgentCard({ agent }: { agent: AgentStatus }) {
  const location = agent.cwd || `PID ${agent.pid ?? '未知'}`;
  const identity = agentIdentity(agent);
  const task = agent.task || '静候符令';
  const tool = agent.waitingFor || agent.currentTool || '尚无器用';
  return (
    <article className="agentCard">
      <div className="agentTitle">
        <div>
          <strong title={identity}>{agent.name}</strong>
          <span className="agentLocation" title={location}>{location}</span>
        </div>
        <StatusBadge status={agent.status} />
      </div>
      <div className="agentBody">
        <div className="taskBlock">
          <div><Terminal size={15} />事务</div>
          <strong title={task}>{task}</strong>
        </div>
        <div className="agentMetrics">
          <Info icon={<Play size={15} />} label="法器" value={tool} />
          <Info icon={<Clock size={15} />} label="时辰" value={formatActiveDuration(agent)} />
        </div>
      </div>
      <footer className="agentFooter">
        <span className="agentUpdated">{formatTime(agent.updatedAt)}</span>
      </footer>
    </article>
  );
}

function ApprovalCard({ approval, onResolve }: { approval: ApprovalRequest; onResolve: (approval: ApprovalRequest, action: 'approve' | 'reject') => Promise<void> }) {
  return (
    <article className="approvalCard">
      <div>
        <strong>{approval.provider.toUpperCase()}</strong>
        <span>{approval.toolName}</span>
      </div>
      <p>{approval.summary}</p>
      {isActionableApproval(approval) ? (
        <div className="approvalActions">
          <button onClick={() => void onResolve(approval, 'approve')}><Check size={15} /> 准行</button>
          <button className="reject" onClick={() => void onResolve(approval, 'reject')}><X size={15} /> 驳回</button>
        </div>
      ) : <div className="approvalHint">请回命令行应答</div>}
    </article>
  );
}

function HistoryTable({ rows }: { rows: TaskHistory[] }) {
  if (!rows.length) return <EmptyState text="暂无卷宗" compact />;
  return (
    <div className="tableWrap">
      <table className="historyTable">
        <colgroup>
          <col className="historyAgentCol" />
          <col className="historyTaskCol" />
          <col className="historyStatusCol" />
          <col className="historyEndedCol" />
          <col className="historyDurationCol" />
        </colgroup>
        <thead>
          <tr>
            <th>道友</th>
            <th>事务</th>
            <th>境况</th>
            <th>归档</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.provider.toUpperCase()}</td>
              <td className="historyTaskCell" title={row.task || row.resultSummary || ''}>
                <span>{row.task || summarizeResult(row.resultSummary) || '暂无记载'}</span>
              </td>
              <td><StatusBadge status={row.finalStatus} /></td>
              <td>{row.endedAt ? formatDateTime(row.endedAt) : '-'}</td>
              <td>{row.durationMs === undefined ? '-' : formatMs(row.durationMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NotificationIconUsageList({ icons, onPreview }: { icons: NotificationIconUsage[]; onPreview: (icon: NotificationIconUsage) => void }) {
  return (
    <div className="iconUsageGrid">
      {icons.map((icon) => <NotificationIconUsageContent icon={icon} onPreview={onPreview} key={icon.path} />)}
    </div>
  );
}

function NotificationIconUsageContent({ icon, onPreview }: { icon: NotificationIconUsage; onPreview: (icon: NotificationIconUsage) => void }) {
  const image = <img src={icon.path} alt="" />;
  const cultivation = notificationIconLevel(icon.count);
  return (
    <div className={`iconUsageItem ${cultivation.breakthrough ? 'isBreakthrough' : ''} rankAura${cultivation.rankIndex}`}>
      <div className="iconUsageAvatar">
        {icon.count >= 10 ? (
          <button className="iconUsageImageButton" type="button" onClick={() => onPreview(icon)} aria-label={`查看${icon.name}原图`}>
            {image}
          </button>
        ) : image}
      </div>
      <div className="iconUsageInfo">
        <div className="iconUsageNameRow">
          <strong>{icon.name}</strong>
          <span className="iconUsageCount">{icon.count}</span>
        </div>
        <div className="iconUsageRealm" aria-label={cultivation.label}>
          <span className={`iconUsageLevel ${cultivation.className}`}>
            <Sparkles size={12} />
            {cultivation.label}
          </span>
          {cultivation.showBreakthroughLabel ? <span className="breakthroughMark"><Flame size={12} />破境</span> : null}
        </div>
        <div
          className="cultivationProgress"
          style={{ '--cultivation-progress': `${cultivation.progress}%` } as React.CSSProperties}
          aria-label={`破境进度 ${cultivation.progress}%`}
        >
          <span />
        </div>
      </div>
    </div>
  );
}

function NotificationIconPreview({ icon, onClose }: { icon: NotificationIconUsage; onClose: () => void }) {
  return (
    <div className="iconPreviewBackdrop" role="dialog" aria-modal="true" aria-label={`${icon.name}原图预览`} onClick={onClose}>
      <div className="iconPreviewDialog" onClick={(event) => event.stopPropagation()}>
        <div className="sectionHeader">
          <h2>{icon.name}</h2>
          <button className="iconPreviewClose" type="button" onClick={onClose} aria-label="关闭预览">
            <X size={18} />
          </button>
        </div>
        <img src={originalNotificationIconPath(icon.path)} alt={icon.name} />
      </div>
    </div>
  );
}

function originalNotificationIconPath(path: string): string {
  return path.replace('/notification-icon/', '/notification-icon/original/');
}

function notificationIconLevel(count: number): CultivationLevel {
  if (count <= 0) {
    return {
      label: '未入品',
      className: 'cultivation cultivationDormant',
      rankIndex: 0,
      progress: 0,
      nextBreakthroughIn: 10,
      breakthrough: false,
      showBreakthroughLabel: false
    };
  }
  const rankIndex = Math.min(Math.floor(count / 10), cultivationRanks.length - 1);
  const level = count % 10;
  const levelLabel = level && rankIndex < cultivationRanks.length - 1 ? `${formatChineseNumber(level)}级` : '';
  const finalRank = rankIndex === cultivationRanks.length - 1;
  return {
    label: `${cultivationRanks[rankIndex]}${levelLabel}`,
    className: `cultivation cultivationRank${rankIndex}`,
    rankIndex,
    progress: finalRank ? 100 : level ? level * 10 : 100,
    nextBreakthroughIn: finalRank ? 0 : level ? 10 - level : 0,
    breakthrough: count >= 10 && level === 0,
    showBreakthroughLabel: count >= 10 && level === 0 && !finalRank
  };
}

function formatChineseNumber(value: number): string {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value < 10) return digits[value];
  if (value < 20) return `十${value % 10 ? digits[value % 10] : ''}`;
  if (value < 100) {
    const ones = value % 10;
    return `${digits[Math.floor(value / 10)]}十${ones ? digits[ones] : ''}`;
  }
  return String(value);
}

function notificationIconLevelLabel(count: number): string {
  return notificationIconLevel(count).label;
}

function StatusBadge({ status }: { status: AgentState }) {
  const label = statusLabel(status);
  return <span className={`badge ${status}`}>{label}</span>;
}

function statusLabel(status: AgentState): string {
  switch (status) {
    case 'running': return '修行';
    case 'waiting_approval': return '候令';
    case 'waiting_input': return '待言';
    case 'finished': return '圆满';
    case 'error': return '异象';
    case 'idle': return '坐化';
    default: return status;
  }
}

function Info({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="info">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyState({ text, compact = false }: { text: string; compact?: boolean }) {
  return <div className={`empty ${compact ? 'compact' : ''}`}><ShieldAlert size={18} />{text}</div>;
}

function upsert<T extends { id: string }>(rows: T[], row: T): T[] {
  const index = rows.findIndex((item) => item.id === row.id);
  if (index === -1) return [row, ...rows];
  const next = [...rows];
  next[index] = row;
  return next;
}

function normalizeAgents(rows: AgentStatus[]): AgentStatus[] {
  const visible = rows
    .filter((agent) => isVisibleAgent(agent, rows))
    .filter((agent) => !isCodexPidDuplicate(agent, rows))
    .map((agent) => toVisibleAgent(agent, rows));
  return visible.map((agent) => ({ ...agent, name: displayName(agent, visible) }));
}

function normalizeSnapshot(snapshot: DashboardSnapshot): DashboardSnapshot {
  return { ...snapshot, agents: normalizeAgents(snapshot.agents) };
}

function agentsOutsideApprovalCenter(agents: AgentStatus[], approvals: ApprovalRequest[]): AgentStatus[] {
  const agentIdsWithApprovals = new Set(approvals.map((approval) => approval.agentId));
  return agents.filter((agent) => agent.status !== 'waiting_approval' || !agentIdsWithApprovals.has(agent.id));
}

function isActionableApproval(approval: ApprovalRequest): boolean {
  return approval.provider === 'claude';
}

function isVisibleAgent(agent: AgentStatus, rows?: AgentStatus[]): boolean {
  return isBaseVisibleAgent(agent);
}

function toVisibleAgent(agent: AgentStatus, rows: AgentStatus[]): AgentStatus {
  const codexSession = isCodexPidFallback(agent) ? latestCodexSessionForPid(agent, rows) : undefined;
  if (codexSession) {
    return {
      ...agent,
      task: codexSession.task ?? agent.task,
      currentTool: codexSession.status === 'running' ? codexSession.currentTool ?? agent.currentTool : agent.currentTool,
      waitingFor: codexSession.status === 'waiting_approval' || codexSession.status === 'waiting_input'
        ? codexSession.waitingFor ?? agent.waitingFor
        : agent.waitingFor,
      lastResult: codexSession.lastResult ?? agent.lastResult
    };
  }
  return agent;
}

function isBaseVisibleAgent(agent: AgentStatus): boolean {
  if (isStaleCodexSession(agent)) return false;
  return agent.status === 'running' ||
    agent.status === 'waiting_approval' ||
    agent.status === 'waiting_input' ||
    agent.status === 'error';
}

function isStaleCodexSession(agent: AgentStatus): boolean {
  return isCodexSessionAgent(agent) &&
    agent.status === 'running' &&
    !agent.activeSince &&
    !agent.currentTool &&
    !agent.waitingFor;
}

function isCodexPidDuplicate(agent: AgentStatus, rows: AgentStatus[]): boolean {
  if (!isCodexPidFallback(agent)) return false;
  const agentPid = Number(agent.providerInstanceId);
  const explicitDuplicate = rows.some((candidate) => {
    if (candidate.provider !== 'codex' || candidate.id === agent.id || candidate.providerInstanceId === agent.providerInstanceId) {
      return false;
    }
    const pids = candidate.metadata?.pids;
    return Array.isArray(pids) && pids.some((pid) => Number(pid) === agentPid);
  });
  return explicitDuplicate || hiddenCodexPidsForWorkspace(agent, rows).some((candidate) => candidate.id === agent.id);
}

function hiddenCodexPidsForWorkspace(agent: AgentStatus, rows: AgentStatus[]): AgentStatus[] {
  const livePids = liveCodexPidsForWorkspace(agent, rows);
  const replacingSessions = visibleCodexSessionsForWorkspace(agent, rows);
  return livePids.slice(0, Math.min(livePids.length, replacingSessions.length));
}

function visibleCodexSessionsForWorkspace(agent: AgentStatus, rows: AgentStatus[]): AgentStatus[] {
  return rows
    .filter(isCodexSessionAgent)
    .filter(isBaseVisibleAgent)
    .filter((candidate) => isSameCodexWorkspace(agent, candidate))
    .sort(recentAgentFirst);
}

function liveCodexPidsForWorkspace(agent: AgentStatus, rows: AgentStatus[]): AgentStatus[] {
  return rows
    .filter(isCodexPidFallback)
    .filter((candidate) => candidate.status === 'running')
    .filter((candidate) => isSameCodexWorkspace(agent, candidate))
    .sort((a, b) => Number(a.providerInstanceId) - Number(b.providerInstanceId));
}

function latestCodexSessionForPid(agent: AgentStatus, rows: AgentStatus[]): AgentStatus | undefined {
  return rows
    .filter(isCodexSessionAgent)
    .filter((candidate) => Boolean(candidate.task))
    .filter((candidate) => isSameCodexWorkspace(agent, candidate))
    .filter((candidate) => !agent.startedAt || !candidate.startedAt || Date.parse(candidate.startedAt) >= Date.parse(agent.startedAt))
    .sort(recentAgentFirst)[0];
}

function isCodexPidFallback(agent: AgentStatus): boolean {
  return agent.provider === 'codex' && /^\d+$/.test(agent.providerInstanceId);
}

function isCodexSessionAgent(agent: AgentStatus): boolean {
  return agent.provider === 'codex' && !/^\d+$/.test(agent.providerInstanceId);
}

function isSameCodexWorkspace(agent: AgentStatus, candidate: AgentStatus): boolean {
  return Boolean(agent.cwd) &&
    pathsOverlap(normalizedPath(agent.cwd), normalizedPath(candidate.cwd));
}

function recentAgentFirst(a: AgentStatus, b: AgentStatus): number {
  return b.updatedAt.localeCompare(a.updatedAt) ||
    (b.startedAt ?? '').localeCompare(a.startedAt ?? '') ||
    a.providerInstanceId.localeCompare(b.providerInstanceId);
}

function normalizedPath(path?: string): string {
  return path?.replace(/\\/g, '/').replace(/\/+$/, '') ?? '';
}

function pathsOverlap(left: string, right: string): boolean {
  return Boolean(left) && Boolean(right) &&
    (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`));
}

function displayName(agent: AgentStatus, rows: AgentStatus[]): string {
  const base = `${providerLabel(agent.provider)} · ${workspaceName(agent)}`;
  const sameBase = rows
    .filter((item) => `${providerLabel(item.provider)} · ${workspaceName(item)}` === base)
    .sort((a, b) => a.providerInstanceId.localeCompare(b.providerInstanceId));
  const index = sameBase.findIndex((item) => item.id === agent.id);
  return index > 0 ? `${base} #${index + 1}` : base;
}

function providerLabel(provider: AgentStatus['provider']): string {
  switch (provider) {
    case 'claude': return 'Claude';
    case 'codex': return 'Codex';
    case 'gemini': return 'Gemini';
    case 'opencode': return 'OpenCode';
    default: return provider;
  }
}

function workspaceName(agent: AgentStatus): string {
  if (agent.cwd) {
    const normalized = agent.cwd.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized.split('/').filter(Boolean).pop() ?? normalized;
  }
  return agent.pid ? `PID ${agent.pid}` : agent.providerInstanceId.slice(0, 8);
}

function agentIdentity(agent: AgentStatus): string {
  if (agent.provider === 'codex' && /^\d+$/.test(agent.providerInstanceId)) {
    return `PID ${agent.providerInstanceId}`;
  }
  if (agent.provider === 'claude' && agent.providerInstanceId.startsWith('process:')) {
    return `PID ${agent.providerInstanceId.slice('process:'.length)}`;
  }
  return `会话 ${agent.providerInstanceId}`;
}

function buildStats(agents: AgentStatus[]) {
  return {
    running: agents.filter((agent) => agent.status === 'running').length,
    waiting: agents.filter((agent) => agent.status === 'waiting_approval' || agent.status === 'waiting_input').length,
    finished: agents.filter((agent) => agent.status === 'finished').length,
    error: agents.filter((agent) => agent.status === 'error').length
  };
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function formatDuration(start?: string, end?: string) {
  if (!start) return '-';
  return formatMs((end ? Date.parse(end) : Date.now()) - Date.parse(start));
}

function formatActiveDuration(agent: AgentStatus) {
  if (agent.activeSince) {
    const label = agent.status === 'waiting_approval' || agent.status === 'waiting_input' ? '候令' : '修行';
    return `${label} ${formatDuration(agent.activeSince, agent.finishedAt)}`;
  }
  return agent.startedAt ? `开坛 ${formatDuration(agent.startedAt, agent.finishedAt)}` : '-';
}

function formatMs(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) return `${hours}时 ${minutes}分`;
  return minutes ? `${minutes}分 ${rest}息` : `${rest}息`;
}

function summarizeResult(value?: string) {
  return value?.split(/\r?\n/).find((line) => line.trim())?.trim();
}

function maybeNotify(agent: AgentStatus) {
  if (agent.status === 'finished') notify(`${agent.name} 已圆满`, agent.task || '事务已毕', completionNotificationKey(agent.id, agent.status, agent.finishedAt, agent.lastResult));
  if (agent.status === 'error') notify(`${agent.name} 生异象`, agent.lastResult || '行事未成', completionNotificationKey(agent.id, agent.status, agent.finishedAt, agent.lastResult));
  if (agent.status === 'waiting_input') notify(`${agent.name} 待传言`, agent.waitingFor || '尚需应答', notificationKey(agent));
}

function maybeNotifyHistory(row: TaskHistory) {
  if (row.finalStatus === 'finished') notify(`${providerLabel(row.provider)} 事务已圆满`, row.task || '事务已毕', completionNotificationKey(row.agentId, row.finalStatus, row.endedAt, row.resultSummary));
  if (row.finalStatus === 'error') notify(`${providerLabel(row.provider)} 事务生异象`, row.resultSummary || '行事未成', completionNotificationKey(row.agentId, row.finalStatus, row.endedAt, row.resultSummary));
}

function notifyApproval(approval: ApprovalRequest, onClick?: () => void) {
  if (approval.provider === 'codex') {
    notify('Codex 候令', `${approval.summary} · 请回命令行应答`, undefined, onClick);
    return;
  }
  notify('使者候令', approval.summary, undefined, onClick);
}

function notify(title: string, body: string, key?: string, onClick?: () => void) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (key && notifiedAgentEventKeys.has(key)) return;
  if (key) notifiedAgentEventKeys.add(key);
  const icon = selectNotificationIcon();
  const notification = new Notification(title, { body, icon, badge: icon });
  notification.onclick = () => {
    onClick?.();
    window.focus();
    document.getElementById('authorization-center')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    notification.close();
  };
}

function selectNotificationIcon(): string {
  const icon = notificationIconPaths[Math.floor(Math.random() * notificationIconPaths.length)];
  incrementNotificationIconUsage(icon);
  return icon;
}

function incrementNotificationIconUsage(icon: string) {
  const usage = readNotificationIconUsageMap();
  usage[icon] = (usage[icon] ?? 0) + 1;
  window.localStorage.setItem(notificationIconUsageStorageKey, JSON.stringify(usage));
  window.dispatchEvent(new Event(notificationIconUsageEvent));
}

function readNotificationIconUsage(): NotificationIconUsage[] {
  const usage = readNotificationIconUsageMap();
  return notificationIconPaths.map((path) => ({
    name: notificationIconName(path),
    path,
    count: usage[path] ?? 0
  })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function readNotificationIconUsageMap(): Record<string, number> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(notificationIconUsageStorageKey) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))) as Record<string, number>;
  } catch {
    return {};
  }
}

function notificationIconName(path: string): string {
  const name = path.split('/').pop()?.replace(/\.png$/i, '') ?? path;
  switch (name) {
    case 'hanli': return '韩立';
    case 'mupeiling': return '慕沛灵';
    case 'nangongwan': return '南宫婉';
    case 'songyu': return '宋玉';
    case 'yinyue': return '银月';
    case 'yuanyao': return '元瑶';
    case 'ziling': return '紫灵';
    default: return name;
  }
}

function notificationKey(agent: AgentStatus): string {
  return [agent.id, agent.status, agent.finishedAt ?? agent.activeSince ?? '', agent.waitingFor ?? '', agent.lastResult ?? ''].join(':');
}

function completionNotificationKey(agentId: string, status: AgentState, endedAt?: string, result?: string): string {
  return ['completion', agentId, status, endedAt ?? '', result ?? ''].join(':');
}

function notificationState(): NotificationPermissionState {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

function notificationLabel(permission: NotificationPermissionState): string {
  switch (permission) {
    case 'granted': return '已启';
    case 'denied': return '已禁';
    case 'unsupported': return '无';
    default: return '未启';
  }
}

function notificationTitle(permission: NotificationPermissionState): string {
  switch (permission) {
    case 'granted': return '灵讯已启';
    case 'denied': return '灵讯被浏览器禁用';
    case 'unsupported': return '此境不支持灵讯';
    default: return '开启灵讯';
  }
}

function initialTheme(): ThemeMode {
  const stored = window.localStorage.getItem(themeStorageKey);
  return isThemeMode(stored) ? stored : 'day';
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'day' || value === 'night' || value === 'eye';
}

function themeLabel(theme: ThemeMode): string {
  switch (theme) {
    case 'night': return '夜墨';
    case 'eye': return '竹青';
    default: return '宣纸';
  }
}

function themeIcon(theme: ThemeMode) {
  switch (theme) {
    case 'night': return <Moon size={18} />;
    case 'eye': return <Eye size={18} />;
    default: return <Sun size={18} />;
  }
}
