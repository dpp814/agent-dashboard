import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bell, Check, ChevronDown, Clock, Copy, Eye, Flame, History, Layers3, Moon, Play, Search, ShieldAlert, Sparkles, Sun, Terminal, Trash2, Volume2, VolumeX, X, Zap } from 'lucide-react';
import type { AgentState, AgentStatus, ApprovalRequest, DashboardSnapshot, TaskHistory, WsMessage } from '@agent-monitor/shared';
import { connectWs, deleteHistorySession, fetchHistoryDetail, fetchSnapshot, resolveApproval, type HistoryDetail, type HistoryProviderFilter } from './api';

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
  historyTotal: 0,
  stats: {
    todayFinished: 0,
    todayError: 0
  },
  updatedAt: new Date().toISOString()
};

const defaultHistoryPageSize = 50;
const historyPageSizeOptions = [5, 10, 20, 50];
const historyProviderOptions: Array<{ value: HistoryProviderFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' }
];
const themeStorageKey = 'agent-monitor-theme';
const historyPageSizeStorageKey = 'agent-monitor-history-page-size';
const themeModes: ThemeMode[] = ['day', 'night', 'eye'];
const transientApprovalMs = 5000;
const notifiedAgentEventKeys = new Set<string>();
const notificationIconUsageStorageKey = 'agent-monitor-notification-icon-usage';
const notificationIconUsageEvent = 'agent-monitor-notification-icon-usage-change';
const iconUsageExpandedStorageKey = 'agent-monitor-icon-usage-expanded';
const notificationSoundStorageKey = 'agent-monitor-notification-sound';
const autoApproveStorageKey = 'agent-monitor-auto-approve';
let notificationAudioContext: AudioContext | undefined;
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
  const [historySessionId, setHistorySessionId] = useState('');
  const [historyProvider, setHistoryProvider] = useState<HistoryProviderFilter>('all');
  const [historyPage, setHistoryPage] = useState(0);
  const [historyPageSize, setHistoryPageSize] = useState(initialHistoryPageSize);
  const [historyPageInput, setHistoryPageInput] = useState('1');
  const [historyDetail, setHistoryDetail] = useState<HistoryDetail>();
  const [error, setError] = useState<string>();
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>(() => notificationState());
  const [notificationIconUsage, setNotificationIconUsage] = useState<NotificationIconUsage[]>(() => readNotificationIconUsage());
  const [iconUsageExpanded, setIconUsageExpanded] = useState(() => initialIconUsageExpanded());
  const [highlightedNotificationIcon, setHighlightedNotificationIcon] = useState<string>();
  const [previewIcon, setPreviewIcon] = useState<NotificationIconUsage>();
  const [theme, setTheme] = useState<ThemeMode>(() => initialTheme());
  const [notificationSoundEnabled, setNotificationSoundEnabled] = useState(() => initialNotificationSoundEnabled());
  const [autoApproveEnabled, setAutoApproveEnabled] = useState(() => initialAutoApproveEnabled());
  const [hiddenApprovalIds, setHiddenApprovalIds] = useState<Set<string>>(() => new Set());
  const autoApprovingIds = useRef(new Set<string>());
  const notifiedApprovalIds = useRef(new Set<string>());
  const transientApprovalTimers = useRef(new Map<string, number>());
  const highlightedNotificationIconTimer = useRef<number | undefined>(undefined);
  const historyQuery = useRef<{ search: string; page: number; pageSize: number; provider: HistoryProviderFilter; sessionId: string }>({
    search: '',
    page: 0,
    pageSize: historyPageSize,
    provider: 'all',
    sessionId: ''
  });
  const visibleApprovals = useMemo(
    () => snapshot.approvals
      .filter((approval) => !hiddenApprovalIds.has(approval.id))
      .filter((approval) => isCurrentApproval(approval, snapshot.agents, snapshot.approvals)),
    [snapshot.approvals, snapshot.agents, hiddenApprovalIds]
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
    window.localStorage.setItem(notificationSoundStorageKey, notificationSoundEnabled ? '1' : '0');
  }, [notificationSoundEnabled]);

  useEffect(() => {
    window.localStorage.setItem(iconUsageExpandedStorageKey, iconUsageExpanded ? '1' : '0');
  }, [iconUsageExpanded]);

  useEffect(() => {
    window.localStorage.setItem(historyPageSizeStorageKey, String(historyPageSize));
  }, [historyPageSize]);

  useEffect(() => {
    if (!notificationSoundEnabled) return;
    const unlock = () => {
      void unlockNotificationSound();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [notificationSoundEnabled]);

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
    historyQuery.current = { search, page: historyPage, pageSize: historyPageSize, provider: historyProvider, sessionId: historySessionId };
    const timer = window.setTimeout(() => {
      fetchSnapshot(search, historyPageSize, historyPage * historyPageSize, historyProvider, historySessionId)
        .then((next) => setSnapshot((current) => mergeHistorySnapshot(current, next)))
        .catch(() => {});
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, historyPage, historyPageSize, historyProvider, historySessionId]);

  useEffect(() => {
    setHistoryPageInput(String(historyPage + 1));
  }, [historyPage]);

  useEffect(() => {
    window.localStorage.setItem(autoApproveStorageKey, autoApproveEnabled ? '1' : '0');
  }, [autoApproveEnabled]);

  useEffect(() => {
    const pendingIds = new Set(snapshot.approvals.map((approval) => approval.id));
    for (const id of autoApprovingIds.current) {
      if (!pendingIds.has(id)) autoApprovingIds.current.delete(id);
    }
    if (!autoApproveEnabled) return;
    for (const approval of actionableApprovals) {
      if (approval.status !== 'pending' || autoApprovingIds.current.has(approval.id)) continue;
      autoApprovingIds.current.add(approval.id);
      onResolveApproval(approval, 'approve').catch((err: Error) => {
        autoApprovingIds.current.delete(approval.id);
        setError(err.message);
      });
    }
  }, [autoApproveEnabled, actionableApprovals, snapshot.approvals]);

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
    void unlockNotificationSound();
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
  }

  function onCycleTheme() {
    setTheme((current) => themeModes[(themeModes.indexOf(current) + 1) % themeModes.length]);
  }

  function onToggleNotificationSound() {
    const next = !notificationSoundEnabled;
    setNotificationSoundEnabled(next);
    window.localStorage.setItem(notificationSoundStorageKey, next ? '1' : '0');
    if (next) {
      void playNotificationSound(true);
    } else {
      void notificationAudioContext?.suspend().catch(() => {});
    }
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
      setSnapshot((current) => {
        const next = normalizeSnapshot(message.payload);
        // Broadcast snapshots use the server default limit; paged history is managed separately.
        return { ...next, history: current.history, historyTotal: current.historyTotal };
      });
      return;
    }
    if (message.type === 'agent') {
      setSnapshot((current) => ({
        ...current,
        agents: normalizeAgents(upsert(current.agents, message.payload)),
        updatedAt: new Date().toISOString()
      }));
      maybeNotify(message.payload, highlightNotificationIcon);
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
        notifyApproval(message.payload, (icon) => {
          highlightNotificationIcon(icon);
          if (message.payload.provider === 'codex') revealTransientApproval(message.payload.id);
        });
      }
      if (message.payload.status !== 'pending') notifiedApprovalIds.current.delete(message.payload.id);
      return;
    }
    if (message.type === 'history') {
      const { search: currentSearch, page, pageSize, provider, sessionId } = historyQuery.current;
      maybeNotifyHistory(message.payload, highlightNotificationIcon);
      if (currentSearch.trim() || provider !== 'all' || sessionId) {
        fetchSnapshot(currentSearch, pageSize, page * pageSize, provider, sessionId)
          .then((next) => setSnapshot((current) => mergeHistorySnapshot(current, next)))
          .catch(() => {});
      } else {
        setSnapshot((current) => ({
          ...current,
          history: page === 0
            ? [message.payload, ...current.history.filter((item) => item.id !== message.payload.id)].slice(0, pageSize)
            : current.history,
          historyTotal: current.history.some((item) => item.id === message.payload.id)
            ? current.historyTotal
            : current.historyTotal + 1
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

  async function onShowHistoryDetail(row: TaskHistory) {
    try {
      setHistoryDetail(await fetchHistoryDetail(row.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDeleteHistorySession(sessionId: string): Promise<boolean> {
    try {
      await deleteHistorySession(sessionId);
      const query = historyQuery.current;
      const clearSessionFilter = query.sessionId === sessionId;
      const nextSearch = clearSessionFilter ? '' : query.search;
      const nextSessionId = clearSessionFilter ? '' : query.sessionId;
      let nextPage = clearSessionFilter ? 0 : query.page;
      let next = await fetchSnapshot(nextSearch, query.pageSize, nextPage * query.pageSize, query.provider, nextSessionId);
      const lastPage = Math.max(0, Math.ceil(next.historyTotal / query.pageSize) - 1);
      if (nextPage > lastPage) {
        nextPage = lastPage;
        next = await fetchSnapshot(nextSearch, query.pageSize, nextPage * query.pageSize, query.provider, nextSessionId);
      }
      if (clearSessionFilter) {
        setSearch('');
        setHistorySessionId('');
      }
      setHistoryPage(nextPage);
      setSnapshot(normalizeSnapshot(next));
      setHistoryDetail(undefined);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  function highlightNotificationIcon(icon: string) {
    if (highlightedNotificationIconTimer.current) window.clearTimeout(highlightedNotificationIconTimer.current);
    setHighlightedNotificationIcon(undefined);
    window.setTimeout(() => setHighlightedNotificationIcon(icon), 0);
    highlightedNotificationIconTimer.current = window.setTimeout(() => setHighlightedNotificationIcon(undefined), 2800);
  }

  const stats = useMemo(
    () => buildStats(visibleAgents, actionableApprovals, snapshot.stats),
    [visibleAgents, actionableApprovals, snapshot.stats]
  );
  const historyTotalPages = Math.max(1, Math.ceil(snapshot.historyTotal / historyPageSize));
  const historyNextDisabled = historyPage + 1 >= historyTotalPages;

  function commitHistoryPageInput() {
    if (!historyPageInput.trim()) {
      setHistoryPageInput(String(historyPage + 1));
      return;
    }
    const requestedPage = Number(historyPageInput);
    if (!Number.isFinite(requestedPage)) {
      setHistoryPageInput(String(historyPage + 1));
      return;
    }
    const nextPage = Math.min(historyTotalPages, Math.max(1, Math.trunc(requestedPage)));
    setHistoryPageInput(String(nextPage));
    setHistoryPage(nextPage - 1);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>AI修仙传</h1>
        </div>
        <div className="topbarActions">
          <NotificationButton permission={notificationPermission} onRequest={onRequestNotifications} />
          <SoundButton enabled={notificationSoundEnabled} onToggle={onToggleNotificationSound} />
          <ThemeButton theme={theme} onCycle={onCycleTheme} />
          <span className={`connection ${connected ? 'ok' : 'bad'}`}>{connected ? '已出关' : '闭关中'}</span>
        </div>
      </header>

      {error ? <div className="errorBar">{error}</div> : null}

      <section className="stats" aria-label="状态概览">
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
            <button
              className={`autoApproveButton ${autoApproveEnabled ? 'isEnabled' : ''}`}
              type="button"
              aria-pressed={autoApproveEnabled}
              title={autoApproveEnabled ? '自动授令已开启，Claude 待批法旨将自动准行' : '开启后 Claude 待批法旨将自动准行'}
              onClick={() => setAutoApproveEnabled((current) => !current)}
            >
              <Zap size={14} />
              <span>{autoApproveEnabled ? '自动授令·开' : '自动授令·关'}</span>
            </button>
          </div>
          <p className="panelNote">Claude 可在此授令，Codex 只暂现片刻，仍需回命令行应答</p>
          <div className="approvalList">
            {visibleApprovals.length ? visibleApprovals.map((approval) => (
              <ApprovalCard key={approval.id} approval={approval} onResolve={onResolveApproval} />
            )) : <EmptyState text="暂无待批法旨" compact />}
          </div>
        </aside>
      </section>

      <section className={`iconUsagePanel ${iconUsageExpanded ? '' : 'isCollapsed'}`} id="notification-icon-usage">
        <div className="sectionHeader">
          <div className="sectionTitle">
            <h2>道友图鉴</h2>
            <span>{notificationIconUsage.reduce((total, icon) => total + icon.count, 0)}</span>
          </div>
          <button
            className={`iconUsageCollapseButton ${iconUsageExpanded ? 'isExpanded' : ''}`}
            type="button"
            aria-expanded={iconUsageExpanded}
            aria-controls="notification-icon-usage-content"
            onClick={() => setIconUsageExpanded((current) => !current)}
          >
            <span>{iconUsageExpanded ? '收起' : '展开'}</span>
            <ChevronDown size={16} />
          </button>
        </div>
        <div
          className={`iconUsageCollapseContent ${iconUsageExpanded ? 'isExpanded' : ''}`}
          id="notification-icon-usage-content"
          aria-hidden={!iconUsageExpanded}
          inert={!iconUsageExpanded ? true : undefined}
        >
          <div className="iconUsageCollapseInner">
            <NotificationIconUsageList icons={notificationIconUsage} highlightedPath={highlightedNotificationIcon} onPreview={setPreviewIcon} />
          </div>
        </div>
      </section>

      {previewIcon ? <NotificationIconPreview icon={previewIcon} onClose={() => setPreviewIcon(undefined)} /> : null}

      <section className="historyPanel">
          <div className="sectionHeader">
            <div className="sectionTitle">
              <h2>卷宗</h2>
            </div>
            <div className="historyTools">
              <div className="historyProviderFilter" role="group" aria-label="卷宗来源">
                {historyProviderOptions.map((option) => (
                  <button
                    key={option.value}
                    className={`${historyProvider === option.value ? 'active' : ''} provider-${option.value}`}
                    type="button"
                    aria-pressed={historyProvider === option.value}
                    onClick={() => {
                      setHistoryProvider(option.value);
                      setHistoryPage(0);
                    }}
                  >
                    <HistoryProviderIcon provider={option.value} />
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
              <label className="searchBox">
                <Search size={16} />
                <input
                  value={search}
                  onChange={(event) => {
                    setHistorySessionId('');
                    setSearch(event.target.value);
                    setHistoryPage(0);
                  }}
                  placeholder="查阅卷宗"
                />
                {search ? (
                  <button
                    className="searchClearButton"
                    type="button"
                    title="清空搜索"
                    aria-label="清空搜索"
                    onClick={() => {
                      setHistorySessionId('');
                      setSearch('');
                      setHistoryPage(0);
                    }}
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </label>
            </div>
          </div>
        <HistoryTable
          rows={snapshot.history}
          onShowDetail={onShowHistoryDetail}
          onShowSessionHistory={(row) => {
            if (!row.providerInstanceId) return;
            setHistorySessionId(row.providerInstanceId);
            setSearch(row.providerInstanceId);
            setHistoryPage(0);
          }}
        />
        <div className="pager historyPager">
          <div className="pagerControls">
            <button disabled={historyPage === 0} onClick={() => setHistoryPage((page) => Math.max(0, page - 1))}>上卷</button>
            <label className="pagerPage">
              <span>第</span>
              <input
                type="number"
                min={1}
                max={historyTotalPages}
                inputMode="numeric"
                aria-label="跳转页码"
                value={historyPageInput}
                onChange={(event) => setHistoryPageInput(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={commitHistoryPageInput}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setHistoryPageInput(String(historyPage + 1));
                  }
                }}
              />
              <span>/ {historyTotalPages} 页</span>
            </label>
            <button disabled={historyNextDisabled} onClick={() => setHistoryPage((page) => page + 1)}>下卷</button>
          </div>
          <label className="pagerMeta">
            <span>每页</span>
            <select
              aria-label="每页条数"
              value={historyPageSize}
              onChange={(event) => {
                setHistoryPageSize(Number(event.target.value));
                setHistoryPage(0);
              }}
            >
              {historyPageSizeOptions.map((pageSize) => (
                <option key={pageSize} value={pageSize}>{pageSize}</option>
              ))}
            </select>
            <span>条，共 {snapshot.historyTotal} 条</span>
          </label>
        </div>
      </section>
      {historyDetail ? (
        <HistoryDetailDrawer
          detail={historyDetail}
          onClose={() => setHistoryDetail(undefined)}
          onDeleteSession={onDeleteHistorySession}
        />
      ) : null}
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`stat ${tone}${value > 0 ? ' active' : ''}`}>
      <span className="statMeta">
        <span className="statDot" aria-hidden="true" />
        <span className="statLabel">{label}</span>
      </span>
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

function SoundButton({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  const title = enabled ? '传音已启' : '静默中';
  return (
    <button className={`iconButton soundButton ${enabled ? 'enabled' : 'disabled'}`} title={title} aria-label={title} onClick={onToggle}>
      {enabled ? <Volume2 size={18} /> : <VolumeX size={18} />}
      <span>{enabled ? '传音' : '静默'}</span>
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

function HistoryTable({ rows, onShowDetail, onShowSessionHistory }: {
  rows: TaskHistory[];
  onShowDetail: (row: TaskHistory) => void;
  onShowSessionHistory: (row: TaskHistory) => void;
}) {
  const [copyFeedback, setCopyFeedback] = useState<{ id: number; target: 'task' | 'resume'; status: 'copied' | 'failed' }>();
  const copyFeedbackTimer = useRef<number | undefined>(undefined);

  async function onCopyTask(row: TaskHistory) {
    const copied = await copyHistoryTask(row);
    setCopyFeedback({ id: row.id, target: 'task', status: copied ? 'copied' : 'failed' });
    if (copyFeedbackTimer.current) window.clearTimeout(copyFeedbackTimer.current);
    copyFeedbackTimer.current = window.setTimeout(() => setCopyFeedback(undefined), 1200);
  }

  async function onCopyResume(row: TaskHistory) {
    const copied = await copyHistoryResume(row);
    setCopyFeedback({ id: row.id, target: 'resume', status: copied ? 'copied' : 'failed' });
    if (copyFeedbackTimer.current) window.clearTimeout(copyFeedbackTimer.current);
    copyFeedbackTimer.current = window.setTimeout(() => setCopyFeedback(undefined), 1200);
  }

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
          {rows.map((row) => {
            const taskText = historyTaskText(row);
            const resumeCommand = historyResumeCommand(row);
            const taskFeedback = copyFeedback?.id === row.id && copyFeedback.target === 'task' ? copyFeedback.status : undefined;
            const resumeFeedback = copyFeedback?.id === row.id && copyFeedback.target === 'resume' ? copyFeedback.status : undefined;
            return (
              <tr key={row.id}>
                <td><HistoryProviderIdentity provider={row.provider} /></td>
                <td className="historyTaskCell" title={taskText}>
                  <div className="historyTaskContent">
                    <span>{taskText || '暂无记载'}</span>
                    <div className="historyTaskActions">
                      <button
                        className="historyCopyButton"
                        type="button"
                        title="查看详情"
                        aria-label="查看详情"
                        onClick={() => onShowDetail(row)}
                      >
                        <Eye size={14} />
                      </button>
                      <button
                        className={`historyCopyButton ${taskFeedback === 'copied' ? 'copied' : ''} ${taskFeedback === 'failed' ? 'failed' : ''}`}
                        type="button"
                        title={copyButtonTitle(taskFeedback, '复制事务')}
                        aria-label={copyButtonTitle(taskFeedback, '复制事务')}
                        disabled={!taskText}
                        onClick={() => void onCopyTask(row)}
                      >
                        {taskFeedback === 'copied' ? <Check size={14} /> : taskFeedback === 'failed' ? <X size={14} /> : <Copy size={14} />}
                      </button>
                      <button
                        className={`historyCopyButton ${resumeFeedback === 'copied' ? 'copied' : ''} ${resumeFeedback === 'failed' ? 'failed' : ''}`}
                        type="button"
                        title={copyButtonTitle(resumeFeedback, '复制会话')}
                        aria-label={copyButtonTitle(resumeFeedback, '复制会话')}
                        disabled={!resumeCommand}
                        onClick={() => void onCopyResume(row)}
                      >
                        {resumeFeedback === 'copied' ? <Check size={14} /> : resumeFeedback === 'failed' ? <X size={14} /> : <Terminal size={14} />}
                      </button>
                      <button
                        className="historyCopyButton historySessionButton"
                        type="button"
                        title="会话历史"
                        aria-label="会话历史"
                        disabled={!row.providerInstanceId}
                        onClick={() => onShowSessionHistory(row)}
                      >
                        <History size={14} />
                      </button>
                    </div>
                  </div>
                </td>
                <td><StatusBadge status={row.finalStatus} /></td>
                <td>{row.endedAt ? formatDateTime(row.endedAt) : '-'}</td>
                <td>{row.durationMs === undefined ? '-' : formatMs(row.durationMs)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryProviderIdentity({ provider }: { provider: TaskHistory['provider'] }) {
  const label = provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : provider;
  return (
    <span className={`historyProviderIdentity provider-${provider}`} title={label} aria-label={label}>
      <span className="historyProviderMark" aria-hidden="true">
        <HistoryProviderIcon provider={provider} size={15} />
      </span>
    </span>
  );
}

function HistoryProviderIcon({ provider, size = 14 }: {
  provider: TaskHistory['provider'] | HistoryProviderFilter;
  size?: number;
}) {
  if (provider === 'claude' || provider === 'codex') {
    return <span className={`historyProviderGlyph brand-${provider}`} style={{ width: size, height: size }} aria-hidden="true" />;
  }
  if (provider === 'all') return <Layers3 size={size} />;
  return <Terminal size={size} />;
}

function HistoryDetailDrawer({ detail, onClose, onDeleteSession }: {
  detail: HistoryDetail;
  onClose: () => void;
  onDeleteSession: (sessionId: string) => Promise<boolean>;
}) {
  const [debugCopied, setDebugCopied] = useState(false);
  const [resultCopied, setResultCopied] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const [resultLong, setResultLong] = useState(false);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const confirmDeleteButtonRef = useRef<HTMLButtonElement>(null);
  const row = detail.history;
  const taskText = historyTaskText(row);
  const resumeCommand = historyResumeCommand(row);
  const resultText = fullResultText(row.resultSummary);
  useLayoutEffect(() => {
    const result = resultRef.current;
    if (!result || resultExpanded) return;
    const updateOverflow = () => setResultLong(result.scrollHeight > result.clientHeight + 1);
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(result);
    return () => observer.disconnect();
  }, [resultText, resultExpanded]);
  useEffect(() => {
    if (deleteConfirmOpen) confirmDeleteButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || deleting) return;
      if (deleteConfirmOpen) setDeleteConfirmOpen(false);
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [deleteConfirmOpen, deleting, onClose]);

  async function onCopyDebug() {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(historyDebugText(detail));
    setDebugCopied(true);
    window.setTimeout(() => setDebugCopied(false), 1200);
  }

  async function onCopyResult() {
    if (!navigator.clipboard || !resultText) return;
    await navigator.clipboard.writeText(resultText);
    setResultCopied(true);
    window.setTimeout(() => setResultCopied(false), 1200);
  }

  async function onDelete() {
    const sessionId = row.providerInstanceId;
    if (!sessionId || deleting) return;
    setDeleting(true);
    if (!await onDeleteSession(sessionId)) {
      setDeleting(false);
      setDeleteConfirmOpen(false);
    }
  }

  return (
    <div className="historyDetailBackdrop" role="dialog" aria-modal="true" aria-label="卷宗详情" onClick={onClose}>
      <aside className="historyDetailDrawer" onClick={(event) => event.stopPropagation()}>
        <header className="historyDetailHeader">
          <div className="historyDetailMeta">
            <div className="historyDetailHeading">
              <h2>卷宗详情</h2>
              <button
                className={`historyDetailIconButton ${debugCopied ? 'copied' : ''}`}
                type="button"
                title={debugCopied ? '已复制' : '复制调试信息'}
                aria-label={debugCopied ? '已复制' : '复制调试信息'}
                onClick={() => void onCopyDebug()}
              >
                {debugCopied ? <Check size={15} /> : <Copy size={15} />}
              </button>
            </div>
            <span>{row.provider.toUpperCase()} · {row.providerInstanceId ?? row.agentId}</span>
          </div>
          <div className="historyDetailHeaderActions">
            <button
              className="historyDeleteButton"
              type="button"
              disabled={!row.providerInstanceId || deleting}
              onClick={() => setDeleteConfirmOpen(true)}
            >
              <Trash2 size={15} />
              删除会话
            </button>
            <button className="iconPreviewClose" type="button" onClick={onClose} aria-label="关闭详情">
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="historyDetailSection">
          <div className="historyDetailTitle">
            <StatusBadge status={row.finalStatus} />
            <strong>{taskText || '暂无记载'}</strong>
          </div>
          {resultText ? (
            <div className={`historyResultBlock ${resultExpanded ? 'expanded' : ''}`}>
              <div className="historyResultHeader">
                <span>结果摘要</span>
                <button
                  className={`historyResultCopyButton ${resultCopied ? 'copied' : ''}`}
                  type="button"
                  title={resultCopied ? '已复制' : '复制结果摘要'}
                  aria-label={resultCopied ? '已复制' : '复制结果摘要'}
                  onClick={() => void onCopyResult()}
                >
                  {resultCopied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
              <p ref={resultRef}>{resultText}</p>
              {resultLong ? (
                <button type="button" onClick={() => setResultExpanded((current) => !current)}>
                  {resultExpanded ? '收起' : '展开全文'}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="historyDetailGrid">
          <DetailField label="归档" value={row.endedAt ? formatDateTime(row.endedAt) : '-'} />
          <DetailField label="开始" value={row.startedAt ? formatDateTime(row.startedAt) : '-'} />
          <DetailField label="耗时" value={row.durationMs === undefined ? '-' : formatMs(row.durationMs)} />
          <DetailField label="会话" value={row.providerInstanceId ?? '-'} />
          <DetailField label="Agent" value={row.agentId} />
          <DetailField label="恢复" value={resumeCommand ?? '-'} />
        </div>

        <section className="historyDetailSection">
          <div className="historyDetailSubhead">
            <h3>事件时间线</h3>
            <span>{detail.events.length}</span>
          </div>
          <div className="historyEventList">
            {detail.events.length ? detail.events.map((event) => (
              <article className="historyEventItem" key={event.id ?? `${event.type}-${event.ts}`}>
                <span>{formatDateTime(event.ts)}</span>
                <strong>{eventTypeLabel(event.type, event.payload)}</strong>
                <p>{eventDisplayText(event) || event.providerInstanceId}</p>
              </article>
            )) : <EmptyState text="暂无事件" compact />}
          </div>
        </section>
      </aside>
      {deleteConfirmOpen && row.providerInstanceId ? (
        <div
          className="historyDeleteConfirmBackdrop"
          onClick={(event) => {
            event.stopPropagation();
            if (event.target === event.currentTarget && !deleting) setDeleteConfirmOpen(false);
          }}
        >
          <section
            className="historyDeleteConfirmDialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="history-delete-title"
            aria-describedby="history-delete-description"
          >
            <div className="historyDeleteConfirmIcon" aria-hidden="true">
              <Trash2 size={20} />
            </div>
            <div className="historyDeleteConfirmCopy">
              <h3 id="history-delete-title">删除整个会话</h3>
              <p id="history-delete-description">该会话在 Agent Panel 中的全部历史和事件将被永久删除，且无法撤销</p>
            </div>
            <div className="historyDeleteConfirmSession">
              <span>会话 ID</span>
              <code title={row.providerInstanceId}>{row.providerInstanceId}</code>
            </div>
            <div className="historyDeleteConfirmActions">
              <button type="button" disabled={deleting} onClick={() => setDeleteConfirmOpen(false)}>取消</button>
              <button
                ref={confirmDeleteButtonRef}
                className="danger"
                type="button"
                disabled={deleting}
                onClick={() => void onDelete()}
              >
                <Trash2 size={15} />
                {deleting ? '删除中' : '确认删除'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="historyDetailField">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function copyButtonTitle(status: 'copied' | 'failed' | undefined, fallback: string): string {
  if (status === 'copied') return '已复制';
  if (status === 'failed') return '复制失败';
  return fallback;
}

function historyTaskText(row: TaskHistory): string {
  return row.task || summarizeResult(row.resultSummary) || '';
}

function historyResumeCommand(row: TaskHistory): string | undefined {
  if (!row.providerInstanceId) return undefined;
  if (row.provider === 'claude' && !row.providerInstanceId.startsWith('process:')) {
    return `claude --resume ${row.providerInstanceId}`;
  }
  if (row.provider === 'codex' && !/^\d+$/.test(row.providerInstanceId)) {
    return `codex resume ${row.providerInstanceId}`;
  }
  return undefined;
}

async function copyHistoryTask(row: TaskHistory): Promise<boolean> {
  const text = historyTaskText(row);
  if (!text || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copyHistoryResume(row: TaskHistory): Promise<boolean> {
  const text = historyResumeCommand(row);
  if (!text || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function historyDebugText(detail: HistoryDetail): string {
  const row = detail.history;
  return [
    `provider: ${row.provider}`,
    `sessionId: ${row.providerInstanceId ?? ''}`,
    `agentId: ${row.agentId}`,
    `status: ${row.finalStatus}`,
    `startedAt: ${row.startedAt ?? ''}`,
    `endedAt: ${row.endedAt ?? ''}`,
    `duration: ${row.durationMs === undefined ? '' : formatMs(row.durationMs)}`,
    `resume: ${historyResumeCommand(row) ?? ''}`,
    '',
    `task: ${historyTaskText(row)}`,
    `result: ${summarizeResult(row.resultSummary)}`,
    '',
    'events:',
    ...detail.events.map((event) => `- ${event.ts} ${event.type} ${eventSummary(event.payload)}`)
  ].join('\n');
}

function eventTypeLabel(type: string, payload?: unknown): string {
  switch (type) {
    case 'started': return '开始';
    case 'tool_started': return '调用工具';
    case 'tool_finished': return isToolFailurePayload(payload) ? '工具失败' : '工具完成';
    case 'approval_requested': return '请求授权';
    case 'input_requested': return '等待输入';
    case 'finished': return '完成';
    case 'error': return '异常';
    case 'heartbeat': return '心跳';
    case 'discovered': return '发现';
    default: return type;
  }
}

function isToolFailurePayload(payload: unknown): boolean {
  const row = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  return String(row.hook_event_name ?? row.hookEventName ?? '') === 'PostToolUseFailure';
}

function eventDisplayText(event: { type: string; payload: unknown }): string {
  if (event.type === 'finished') return '见上方结果摘要';
  if (event.type === 'error') return eventSummary(event.payload) || '见上方结果摘要';
  return eventSummary(event.payload);
}

function eventSummary(payload: unknown): string {
  const row = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const input = row.tool_input && typeof row.tool_input === 'object' ? row.tool_input as Record<string, unknown> : {};
  return String(
    row.tool_name ??
    row.toolName ??
    row.name ??
    row.command ??
    row.filePath ??
    input.command ??
    input.file_path ??
    input.path ??
    row.message ??
    row.error ??
    row.result ??
    row.last_assistant_message ??
    ''
  );
}

function NotificationIconUsageList({ icons, highlightedPath, onPreview }: {
  icons: NotificationIconUsage[];
  highlightedPath?: string;
  onPreview: (icon: NotificationIconUsage) => void;
}) {
  return (
    <div className="iconUsageGrid">
      {icons.map((icon) => (
        <NotificationIconUsageContent
          highlighted={icon.path === highlightedPath}
          icon={icon}
          onPreview={onPreview}
          key={icon.path}
        />
      ))}
    </div>
  );
}

function NotificationIconUsageContent({ icon, highlighted, onPreview }: {
  icon: NotificationIconUsage;
  highlighted: boolean;
  onPreview: (icon: NotificationIconUsage) => void;
}) {
  const image = <img src={icon.path} alt="" />;
  const cultivation = notificationIconLevel(icon.count);
  return (
    <div className={`iconUsageItem ${cultivation.breakthrough ? 'isBreakthrough' : ''} ${highlighted ? 'isHighlighted' : ''} rankAura${cultivation.rankIndex}`}>
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
    breakthrough: finalRank || (count >= 10 && level === 0),
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
  return {
    ...snapshot,
    agents: normalizeAgents(snapshot.agents),
    historyTotal: snapshot.historyTotal ?? snapshot.history.length,
    stats: snapshot.stats ?? emptySnapshot.stats
  };
}

function mergeHistorySnapshot(current: DashboardSnapshot, next: DashboardSnapshot): DashboardSnapshot {
  return {
    ...current,
    history: next.history,
    historyTotal: next.historyTotal ?? next.history.length
  };
}

function agentsOutsideApprovalCenter(agents: AgentStatus[], approvals: ApprovalRequest[]): AgentStatus[] {
  const agentIdsWithApprovals = new Set(approvals.map((approval) => approval.agentId));
  return agents.filter((agent) => agent.status !== 'waiting_approval' || !agentIdsWithApprovals.has(agent.id));
}

function isActionableApproval(approval: ApprovalRequest): boolean {
  return approval.provider === 'claude';
}

function isCurrentApproval(approval: ApprovalRequest, agents: AgentStatus[], approvals: ApprovalRequest[]): boolean {
  if (approval.provider !== 'claude') return true;
  const latestApproval = approvals
    .filter((item) => item.provider === 'claude' && item.agentId === approval.agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latestApproval?.id !== approval.id) return false;
  const agent = agents.find((item) => item.id === approval.agentId);
  return Boolean(agent?.approval?.id === approval.id ||
    agent?.status === 'waiting_approval' ||
    agent?.waitingFor?.toLowerCase().includes('permission'));
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

function buildStats(agents: AgentStatus[], approvals: ApprovalRequest[], snapshotStats: DashboardSnapshot['stats']) {
  return {
    running: agents.filter((agent) => agent.status === 'running').length,
    waiting: approvals.length + agents.filter((agent) => agent.status === 'waiting_approval' || agent.status === 'waiting_input').length,
    finished: snapshotStats.todayFinished,
    error: snapshotStats.todayError
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
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
  return Number.isFinite(ms) ? formatMs(ms) : '-';
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

function fullResultText(value?: string) {
  return value?.trim() ?? '';
}

function maybeNotify(agent: AgentStatus, onClick?: (icon: string) => void) {
  if (agent.status === 'finished') notify(`${agent.name} 已圆满`, agent.task || '事务已毕', completionNotificationKey(agent.id, agent.status, agent.finishedAt, agent.lastResult), onClick);
  if (agent.status === 'error') notify(`${agent.name} 生异象`, agent.lastResult || '行事未成', completionNotificationKey(agent.id, agent.status, agent.finishedAt, agent.lastResult), onClick);
  if (agent.status === 'waiting_input') notify(`${agent.name} 待传言`, agent.waitingFor || '尚需应答', notificationKey(agent), onClick);
}

function maybeNotifyHistory(row: TaskHistory, onClick?: (icon: string) => void) {
  if (row.finalStatus === 'finished') notify(`${providerLabel(row.provider)} 事务已圆满`, row.task || '事务已毕', completionNotificationKey(row.agentId, row.finalStatus, row.endedAt, row.resultSummary), onClick);
  if (row.finalStatus === 'error') notify(`${providerLabel(row.provider)} 事务生异象`, row.resultSummary || '行事未成', completionNotificationKey(row.agentId, row.finalStatus, row.endedAt, row.resultSummary), onClick);
}

function notifyApproval(approval: ApprovalRequest, onClick?: (icon: string) => void) {
  if (approval.provider === 'codex') {
    notify('Codex 候令', `${approval.summary} · 请回命令行应答`, undefined, onClick);
    return;
  }
  notify('使者候令', approval.summary, undefined, onClick);
}

function notify(title: string, body: string, key?: string, onClick?: (icon: string) => void) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (key && notifiedAgentEventKeys.has(key)) return;
  if (key) notifiedAgentEventKeys.add(key);
  const icon = selectNotificationIcon();
  const notification = new Notification(title, { body, icon, badge: icon });
  playNotificationSound();
  notification.onclick = () => {
    onClick?.(icon);
    window.focus();
    document.getElementById('notification-icon-usage')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    notification.close();
  };
}

async function playNotificationSound(force = false) {
  if (!force && !isNotificationSoundEnabled()) return;
  const context = getNotificationAudioContext();
  if (!context) return;
  try {
    await resumeNotificationAudioContext(context);
    playTone(context, 660, 0, 0.11);
    playTone(context, 880, 0.13, 0.16);
  } catch {
    // Browsers may block audio before user interaction.
  }
}

async function unlockNotificationSound() {
  if (!isNotificationSoundEnabled()) return;
  const context = getNotificationAudioContext();
  if (!context) return;
  try {
    await resumeNotificationAudioContext(context);
  } catch {
    // Browsers may block audio before user interaction.
  }
}

async function resumeNotificationAudioContext(context: AudioContext) {
  if (context.state === 'suspended') await context.resume();
}

function getNotificationAudioContext(): AudioContext | undefined {
  if (notificationAudioContext && notificationAudioContext.state !== 'closed') return notificationAudioContext;
  const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;
  try {
    notificationAudioContext = new AudioContextCtor();
    return notificationAudioContext;
  } catch {
    return undefined;
  }
}

function playTone(context: AudioContext, frequency: number, delay: number, duration: number) {
  const start = context.currentTime + delay;
  const gain = context.createGain();
  const oscillator = context.createOscillator();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.14, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
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

function initialNotificationSoundEnabled(): boolean {
  return window.localStorage.getItem(notificationSoundStorageKey) !== '0';
}

function initialAutoApproveEnabled(): boolean {
  return window.localStorage.getItem(autoApproveStorageKey) === '1';
}

function initialHistoryPageSize(): number {
  const stored = Number(window.localStorage.getItem(historyPageSizeStorageKey));
  return historyPageSizeOptions.includes(stored) ? stored : defaultHistoryPageSize;
}

function initialIconUsageExpanded(): boolean {
  return window.localStorage.getItem(iconUsageExpandedStorageKey) !== '0';
}

function isNotificationSoundEnabled(): boolean {
  return window.localStorage.getItem(notificationSoundStorageKey) !== '0';
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
