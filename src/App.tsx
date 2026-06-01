import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Database,
  Gauge,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogIn,
  Play,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  TimerReset,
} from 'lucide-react';
import { type FormEvent, type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ClientApiError, monitorApi } from './clientApi';
import type {
  AccountQuotaRow,
  AccountQuotaStatus,
  ConsumptionWindowSummary,
  LatestPayload,
  PlanKey,
  PricingProfile,
  RefreshBucket,
} from './shared/domain';
import { DEFAULT_PRICING_PROFILE, formatUsd, getPlanLabel, normalizePricingProfile } from './shared/pricing';

type AppRoute = 'overview' | 'accounts' | 'refresh-times';
type StatusFilter = 'all' | AccountQuotaStatus;
type PlanFilter = 'all' | PlanKey;
type BucketMode = 'all' | 'five-hour' | 'weekly';
type BucketSort = 'time' | 'count';

const PAGE_AUTO_REFRESH_MINUTES = 5;
const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const PLAN_ORDER: Array<Exclude<PlanKey, 'unknown'>> = ['free', 'plus', 'team', 'pro'];
const ROUTES: Array<{ id: AppRoute; label: string; icon: ReactNode }> = [
  { id: 'overview', label: '总览', icon: <LayoutDashboard size={16} aria-hidden="true" /> },
  { id: 'accounts', label: '账号明细', icon: <ListChecks size={16} aria-hidden="true" /> },
  { id: 'refresh-times', label: '刷新时间分布', icon: <CalendarClock size={16} aria-hidden="true" /> },
];

function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
}

function formatDateTime(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function formatTime(value: number | null | undefined): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function formatHours(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  if (value >= 24) return `${(value / 24).toFixed(1)} 天`;
  if (value >= 10) return `${value.toFixed(0)} 小时`;
  return `${value.toFixed(1)} 小时`;
}

function formatPercent(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${Math.round(value)}%`;
}

function formatRelativeAge(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  const minutes = Math.floor(value / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatConsumptionWindow(value: ConsumptionWindowSummary): string {
  if (value.comparableSeries === 0) return '暂无样本';
  if (value.totalUsd <= 0 && !value.zeroConsumptionReliable) return '未采到消耗';
  return formatUsd(value.totalUsd);
}

function formatBurnRateBasis(value: LatestPayload['risk']['burnRateBasis']): string {
  if (value === 'three-hour') return '近 3h 均速';
  if (value === 'one-hour') return '近 1h 提速';
  if (value === 'thirty-minute-spike') return '近 30m 突增';
  if (value === 'zero') return '近期低消耗';
  return '样本不足';
}

function formatHourlyBurn(latest: LatestPayload): string {
  if (latest.risk.hourlyBurnUsd === null) return '样本不足';
  return formatUsd(latest.risk.hourlyBurnUsd);
}

function formatCollectorProgress(latest: LatestPayload): string {
  const state = latest.collectorState;
  if (state.status !== 'collecting') return '';
  const total = state.progressTotalAccounts;
  const completed = state.progressCompletedAccounts ?? 0;
  if (typeof total !== 'number' || !Number.isFinite(total)) return '';
  if (total <= 0) return '，本轮无到期账号';
  return `，本轮查询 ${formatInteger(Math.min(completed, total))}/${formatInteger(total)}`;
}

function formatCurveOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return '现在';
  return `+${Math.round(offsetMinutes / 60)}h`;
}

function getRouteFromHash(): AppRoute | null {
  const value = window.location.hash.replace(/^#\/?/, '');
  if (value === 'overview' || value === 'accounts' || value === 'refresh-times') return value;
  return null;
}

function navigateTo(route: AppRoute): void {
  if (window.location.hash !== `#/${route}`) {
    window.location.hash = `#/${route}`;
    return;
  }
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function handlePanelKey(event: KeyboardEvent<HTMLElement>, route: AppRoute): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  navigateTo(route);
}

function getStatusLabel(status: AccountQuotaStatus): string {
  if (status === 'active') return '启用';
  if (status === 'paused') return '暂停';
  if (status === 'unknown') return '未知';
  return '失败';
}

function isIssueRow(row: AccountQuotaRow): boolean {
  return (
    !row.disabled &&
    (row.status === 'failed' ||
      row.status === 'unknown' ||
      row.quotaSource === 'failed' ||
      row.quotaSource === 'backoff' ||
      row.quotaSource === 'pending')
  );
}

function getQuotaSourceLabel(row: AccountQuotaRow): string {
  if (row.quotaSource === 'paused') return '-';
  if (row.quotaSource === 'fresh') return row.quotaAgeMs !== null && row.quotaAgeMs < 120_000 ? '刚采集' : `采集 ${formatRelativeAge(row.quotaAgeMs)}`;
  if (row.quotaSource === 'cached') return `缓存 ${formatRelativeAge(row.quotaAgeMs)}`;
  if (row.quotaSource === 'backoff') return row.backoffUntil ? `退避至 ${formatTime(row.backoffUntil)}` : '退避中';
  if (row.quotaSource === 'pending') return '等待采集';
  return '采集失败';
}

function getQuotaSourceTitle(row: AccountQuotaRow): string {
  if (row.quotaSource === 'fresh') return `真实查询时间：${formatDateTime(row.quotaSampledAt)}`;
  if (row.quotaSource === 'cached') return `沿用上次真实 quota：${formatDateTime(row.quotaSampledAt)}`;
  if (row.quotaSource === 'backoff') return row.error ?? '账号 usage 查询退避中';
  if (row.quotaSource === 'pending') return '该账号还没有可沿用的 quota 样本';
  if (row.quotaSource === 'failed') return row.error ?? '本轮 usage 查询失败';
  return '暂停账号不请求 quota';
}

function formatRecent30m(row: AccountQuotaRow): string {
  if (row.status === 'paused') return '-';
  if (row.recent30mConsumptionState === 'no-sample') return '暂无样本';
  if (row.recent30mConsumptionState === 'unpriced') return '未计价';
  return formatUsd(row.recent30mConsumedUsd ?? 0);
}

function previewAccounts(accounts: string[]): string {
  if (accounts.length === 0) return '-';
  const preview = accounts.slice(0, 5).join('、');
  return accounts.length > 5 ? `${preview} 等 ${accounts.length} 个` : preview;
}

function matchesAccountQuery(row: AccountQuotaRow, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    row.name.toLowerCase().includes(normalized) ||
    row.accountId?.toLowerCase().includes(normalized) ||
    row.planType?.toLowerCase().includes(normalized) ||
    getPlanLabel(row.normalizedPlan, row.planType).toLowerCase().includes(normalized)
  );
}

function filterAccountRows(
  rows: AccountQuotaRow[],
  query: string,
  status: StatusFilter,
  plan: PlanFilter,
  issuesOnly: boolean,
): AccountQuotaRow[] {
  return rows.filter((row) => {
    if (!matchesAccountQuery(row, query)) return false;
    if (status !== 'all' && row.status !== status) return false;
    if (plan !== 'all' && row.normalizedPlan !== plan) return false;
    if (issuesOnly && !isIssueRow(row)) return false;
    return true;
  });
}

function filterBucketAccounts(accounts: string[], query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return accounts;
  return accounts.filter((name) => name.toLowerCase().includes(normalized));
}

function makeVisibleBucket(bucket: RefreshBucket, query: string, mode: BucketMode): RefreshBucket | null {
  const fiveHourAccounts = mode === 'weekly' ? [] : filterBucketAccounts(bucket.fiveHourAccounts, query);
  const weeklyAccounts = mode === 'five-hour' ? [] : filterBucketAccounts(bucket.weeklyAccounts, query);
  if (fiveHourAccounts.length === 0 && weeklyAccounts.length === 0) return null;
  return { ...bucket, fiveHourAccounts, weeklyAccounts };
}

function getBucketTotal(bucket: RefreshBucket): number {
  return bucket.fiveHourAccounts.length + bucket.weeklyAccounts.length;
}

function filterRefreshBuckets(
  buckets: RefreshBucket[],
  query: string,
  mode: BucketMode,
  sort: BucketSort,
): RefreshBucket[] {
  const filtered = buckets
    .map((bucket) => makeVisibleBucket(bucket, query, mode))
    .filter((bucket): bucket is RefreshBucket => Boolean(bucket));

  if (sort === 'count') {
    return filtered.sort((left, right) => getBucketTotal(right) - getBucketTotal(left) || left.sortMinute - right.sortMinute);
  }
  return filtered.sort((left, right) => left.sortMinute - right.sortMinute);
}

function buildTimelineBuckets(buckets: RefreshBucket[]): RefreshBucket[] {
  const map = new Map(buckets.map((bucket) => [bucket.sortMinute, bucket]));
  return Array.from({ length: 288 }, (_, index) => {
    const sortMinute = index * 5;
    const hour = Math.floor(sortMinute / 60);
    const minute = sortMinute % 60;
    const label = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    return map.get(sortMinute) ?? { bucket: label, sortMinute, fiveHourAccounts: [], weeklyAccounts: [] };
  });
}

function getPeakBuckets(buckets: RefreshBucket[], limit: number): RefreshBucket[] {
  return [...buckets]
    .filter((bucket) => getBucketTotal(bucket) > 0)
    .sort((left, right) => getBucketTotal(right) - getBucketTotal(left) || left.sortMinute - right.sortMinute)
    .slice(0, limit);
}

function getFilteredStats(rows: AccountQuotaRow[]) {
  const countableRows = rows.filter(
    (row) => row.status === 'active' && (row.quotaSource === 'fresh' || row.quotaSource === 'cached'),
  );
  const unpricedFiveHour = countableRows.filter((row) => row.fiveHour && !row.fiveHour.priced).length;
  const unpricedWeekly = countableRows.filter((row) => row.weekly && !row.weekly.priced).length;
  return {
    total: rows.length,
    active: rows.filter((row) => row.status === 'active').length,
    paused: rows.filter((row) => row.status === 'paused').length,
    issues: rows.filter(isIssueRow).length,
    counted: countableRows.length,
    unpriced: unpricedFiveHour + unpricedWeekly,
  };
}

function KpiCard({
  icon,
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}) {
  return (
    <article className={`kpi kpi-${tone}`}>
      <div className="kpi-icon">{icon}</div>
      <div>
        <div className="kpi-label">{label}</div>
        <div className="kpi-value">{value}</div>
        <div className="kpi-hint">{hint}</div>
      </div>
    </article>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric-pill">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LoginPanel({
  monitorKey,
  error,
  loading,
  onChange,
  onSubmit,
}: {
  monitorKey: string;
  error: string | null;
  loading: boolean;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <main className="login-shell">
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-mark">
          <ShieldCheck size={28} aria-hidden="true" />
        </div>
        <div>
          <p className="eyebrow">CPA Quota Monitor</p>
          <h1 id="login-title">登录监控服务</h1>
          <p className="login-copy">输入 MONITOR_KEY。CPA Management Key 只保存在服务端环境变量里。</p>
        </div>

        <form className="login-form" onSubmit={onSubmit}>
          <label>
            <span>Monitor Key</span>
            <input
              value={monitorKey}
              onChange={(event) => onChange(event.target.value)}
              placeholder="输入监控页密码"
              type="password"
              autoComplete="current-password"
            />
          </label>

          {error ? (
            <div className="inline-alert" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}

          <button className="button button-primary" type="submit" disabled={loading}>
            {loading ? <RefreshCw size={16} className="spin" aria-hidden="true" /> : <LogIn size={16} aria-hidden="true" />}
            <span>{loading ? '连接中' : '登录'}</span>
          </button>
        </form>
      </section>
    </main>
  );
}

function RiskDashboard({ latest }: { latest: LatestPayload }) {
  const risk = latest.risk;
  const collectorState = latest.collectorState;
  const collection = latest.snapshot?.collection;
  const strategyLabel =
    collection?.strategy === 'full' ? '智能采集' : collection?.strategy === 'continuous' ? '自动巡检' : '智能轮询';
  const collectionPrefix = collectorState.status === 'collecting' ? '上一轮' : '本轮';
  const collectionText = collection
    ? `${collectionPrefix}${strategyLabel}：真实查询 ${formatInteger(collection.freshAccounts)}，新增/恢复优先 ${formatInteger(collection.priorityAccounts)}，缓存 ${formatInteger(collection.cachedAccounts)}，退避 ${formatInteger(collection.backoffAccounts)}，等待 ${formatInteger(collection.pendingAccounts)}，失败 ${formatInteger(collection.failedAccounts)}`
    : '暂无采集摘要';
  const maxProjected = Math.max(1, ...risk.curve.map((point) => point.projectedUsd));

  return (
    <section className={`risk-panel risk-${risk.tone}`} aria-label="号池风险判断">
      <div className="risk-main">
        <div className="prediction-icon">
          <Clock size={22} aria-hidden="true" />
        </div>
        <div>
          <p className="eyebrow">号池稳定性预警</p>
          <h2>{risk.title}</h2>
          <p>{risk.detail}</p>
          <p className="collector-line">
            保守 5h {formatUsd(risk.conservativeFiveHourUsd)}，账面 5h {formatUsd(risk.nominalFiveHourUsd)}，预计可撑{' '}
            {formatHours(risk.availableHours)}，预计耗尽 {formatDateTime(risk.estimatedDepletionAt)}
          </p>
          <p className="collector-line">
            采集状态：{collectorState.status}
            {formatCollectorProgress(latest)}，下次采集 {formatTime(collectorState.nextRunAt)}
            {collectorState.lastError ? `，错误：${collectorState.lastError}` : ''}
          </p>
          <p className="collector-line">{collectionText}</p>
        </div>
      </div>

      <div className="risk-side">
        <div className="risk-metrics">
          <MetricPill label="估算每小时" value={formatHourlyBurn(latest)} />
          <MetricPill label="近 3 小时消耗" value={formatConsumptionWindow(latest.consumption.threeHours)} />
          <MetricPill label="估算口径" value={formatBurnRateBasis(risk.burnRateBasis)} />
          <MetricPill label="消耗覆盖" value={formatPercent(risk.consumptionCoveragePercent)} />
          <MetricPill label="可信覆盖" value={formatPercent(risk.trustedCoveragePercent)} />
        </div>
        <div className="capacity-curve" aria-label="未来 5 小时容量曲线">
          {risk.curve.map((point) => (
            <div className="curve-point" key={point.offsetMinutes}>
              <div className="curve-bar-track">
                <div
                  className="curve-bar"
                  style={{ height: `${Math.max(8, Math.round((point.projectedUsd / maxProjected) * 100))}%` }}
                />
              </div>
              <span>{formatCurveOffset(point.offsetMinutes)}</span>
              <strong>{formatUsd(point.projectedUsd)}</strong>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PageNav({ route }: { route: AppRoute }) {
  return (
    <nav className="page-nav" aria-label="监控页面">
      {ROUTES.map((item) => (
        <button
          key={item.id}
          className={`nav-button ${route === item.id ? 'nav-button-active' : ''}`}
          onClick={() => navigateTo(item.id)}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function AccountTable({
  rows,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  rows: AccountQuotaRow[];
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * pageSize;
  const pageRows = rows.slice(startIndex, startIndex + pageSize);
  const rangeStart = rows.length === 0 ? 0 : startIndex + 1;
  const rangeEnd = Math.min(startIndex + pageSize, rows.length);

  return (
    <>
      <div className="table-toolbar">
        <div className="table-range">
          {rangeStart}-{rangeEnd} / 共 {formatInteger(rows.length)} 条
        </div>
        <div className="pager-controls">
          <select
            className="select compact-select"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
            aria-label="每页条数"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                每页 {size}
              </option>
            ))}
          </select>
          <button className="icon-button" title="上一页" disabled={safePage <= 1} onClick={() => onPageChange(safePage - 1)}>
            <ChevronLeft size={17} aria-hidden="true" />
          </button>
          <span className="page-indicator">
            {safePage} / {totalPages}
          </span>
          <button
            className="icon-button"
            title="下一页"
            disabled={safePage >= totalPages}
            onClick={() => onPageChange(safePage + 1)}
          >
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="table-wrap detail-table-wrap">
        <table className="accounts-table">
          <thead>
            <tr>
              <th className="sticky-col">账号名</th>
              <th>状态</th>
              <th>套餐</th>
              <th>5h 剩余 $</th>
              <th>5h 刷新时间</th>
              <th>周剩余 $</th>
              <th>周刷新时间</th>
              <th>近 30 分钟消耗 $</th>
              <th>数据来源</th>
              <th>错误信息</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={10} className="empty-cell">
                  没有匹配的 Codex 账号
                </td>
              </tr>
            ) : (
              pageRows.map((row) => (
                <tr key={`${row.cpaId}:${row.name}`}>
                  <td className="sticky-col">
                    <div className="account-name">{row.name}</div>
                    {row.accountId ? <div className="account-sub">{row.accountId}</div> : null}
                  </td>
                  <td>
                    <span className={`status status-${row.status}`}>{getStatusLabel(row.status)}</span>
                  </td>
                  <td>{getPlanLabel(row.normalizedPlan, row.planType)}</td>
                  <td>{formatUsd(row.fiveHour?.remainingUsd)}</td>
                  <td>{formatDateTime(row.fiveHour?.resetAtMs)}</td>
                  <td>{formatUsd(row.weekly?.remainingUsd)}</td>
                  <td>{formatDateTime(row.weekly?.resetAtMs)}</td>
                  <td>{formatRecent30m(row)}</td>
                  <td>
                    <span className={`source-badge source-${row.quotaSource}`} title={getQuotaSourceTitle(row)}>
                      {getQuotaSourceLabel(row)}
                    </span>
                  </td>
                  <td className={row.error ? 'error-text' : 'muted-text'}>{row.error ?? '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function PricingPanel({
  profile,
  saving,
  error,
  onClose,
  onSave,
}: {
  profile: PricingProfile;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (profile: PricingProfile) => void;
}) {
  const [draft, setDraft] = useState<PricingProfile>(() => normalizePricingProfile(profile));

  const updatePlan = (plan: Exclude<PlanKey, 'unknown'>, key: 'fiveHourUsd' | 'weeklyUsd', value: string) => {
    setDraft((current) => ({
      ...current,
      plans: {
        ...current.plans,
        [plan]: {
          ...current.plans[plan],
          [key]: value.trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value),
        },
      },
    }));
  };

  return (
    <section className="workspace-section pricing-panel">
      <div className="section-head">
        <div>
          <h2>价格表配置</h2>
          <p>按社区实测折算，非官方账单金额；留空表示该窗口未计价。</p>
        </div>
        <div className="actions compact-actions">
          <button className="button button-secondary" onClick={onClose}>
            关闭
          </button>
          <button className="button button-primary" disabled={saving} onClick={() => onSave(draft)}>
            {saving ? <RefreshCw size={16} className="spin" aria-hidden="true" /> : <Settings size={16} aria-hidden="true" />}
            <span>保存价格表</span>
          </button>
        </div>
      </div>
      {error ? (
        <div className="inline-alert pricing-alert" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
      <div className="pricing-grid">
        {PLAN_ORDER.map((plan) => (
          <div className="pricing-row" key={plan}>
            <strong>{getPlanLabel(plan)}</strong>
            <label>
              <span>5h 美元</span>
              <input
                value={draft.plans[plan].fiveHourUsd ?? ''}
                onChange={(event) => updatePlan(plan, 'fiveHourUsd', event.target.value)}
                inputMode="decimal"
                placeholder="未计价"
              />
            </label>
            <label>
              <span>周限美元</span>
              <input
                value={draft.plans[plan].weeklyUsd ?? ''}
                onChange={(event) => updatePlan(plan, 'weeklyUsd', event.target.value)}
                inputMode="decimal"
                placeholder="未计价"
              />
            </label>
          </div>
        ))}
      </div>
    </section>
  );
}

function OverviewPage({ latest }: { latest: LatestPayload }) {
  const stats = latest.snapshot?.stats;
  const risk = latest.risk;
  const issueRows = latest.accounts.filter(isIssueRow).slice(0, 4);
  const peakBuckets = getPeakBuckets(latest.refreshBuckets, 5);

  return (
    <div className="page-stack">
      <section className="kpi-grid compact-kpi-grid" aria-label="账号池指标">
        <KpiCard
          icon={<Gauge size={22} aria-hidden="true" />}
          label="5h 保守可用"
          value={formatUsd(risk.conservativeFiveHourUsd)}
          hint={`账面 ${formatUsd(risk.nominalFiveHourUsd)}，过期缓存 ${formatInteger(risk.staleCachedAccounts)} 个`}
          tone="good"
        />
        <KpiCard
          icon={<TimerReset size={22} aria-hidden="true" />}
          label="周保守可用"
          value={formatUsd(risk.conservativeWeeklyUsd)}
          hint={`账面 ${formatUsd(risk.nominalWeeklyUsd)}，未计价 ${formatInteger(stats?.unpricedWeeklyAccounts ?? 0)} 个`}
        />
        <KpiCard
          icon={<Clock size={22} aria-hidden="true" />}
          label="预计可撑"
          value={formatHours(risk.availableHours)}
          hint={`预计耗尽 ${formatDateTime(risk.estimatedDepletionAt)}`}
          tone={risk.tone === 'critical' || risk.tone === 'warn' ? 'bad' : risk.tone === 'watch' ? 'warn' : 'neutral'}
        />
        <KpiCard
          icon={<Activity size={22} aria-hidden="true" />}
          label="估算每小时消耗"
          value={formatHourlyBurn(latest)}
          hint={`${formatBurnRateBasis(risk.burnRateBasis)}，消耗覆盖 ${formatPercent(risk.consumptionCoveragePercent)}`}
          tone={risk.spikeDetected ? 'warn' : 'neutral'}
        />
        <KpiCard
          icon={<Activity size={22} aria-hidden="true" />}
          label="启用 / 计入"
          value={formatInteger(stats?.enabledAccounts ?? 0)}
          hint={`保守计入 ${formatInteger(risk.freshUsableAccounts + risk.trustedCachedAccounts)}，暂停 ${formatInteger(stats?.pausedAccounts ?? 0)}`}
        />
        <KpiCard
          icon={<AlertTriangle size={22} aria-hidden="true" />}
          label="失败/未知账号数"
          value={formatInteger(stats?.failedOrUnknownAccounts ?? 0)}
          hint="不参与美元总额统计"
          tone={(stats?.failedOrUnknownAccounts ?? 0) > 0 ? 'bad' : 'neutral'}
        />
      </section>

      <RiskDashboard latest={latest} />

      <section className="overview-grid">
        <article
          className="overview-panel panel-link"
          role="button"
          tabIndex={0}
          onClick={() => navigateTo('accounts')}
          onKeyDown={(event) => handlePanelKey(event, 'accounts')}
        >
          <div className="section-head section-head-plain">
            <div>
              <h2>异常账号预览</h2>
              <p>失败/未知账号会从美元总额中排除。</p>
            </div>
            <span className="panel-count">{formatInteger(stats?.failedOrUnknownAccounts ?? 0)}</span>
          </div>
          <div className="preview-list">
            {issueRows.length === 0 ? (
              <div className="empty-preview">暂无异常账号</div>
            ) : (
              issueRows.map((row) => (
                <div className="preview-row" key={`${row.cpaId}:${row.name}`}>
                  <span className={`status status-${row.status}`}>{getStatusLabel(row.status)}</span>
                  <strong>{row.name}</strong>
                  <span>{row.error ?? '缺少 quota 数据'}</span>
                </div>
              ))
            )}
          </div>
        </article>

        <article
          className="overview-panel panel-link"
          role="button"
          tabIndex={0}
          onClick={() => navigateTo('refresh-times')}
          onKeyDown={(event) => handlePanelKey(event, 'refresh-times')}
        >
          <div className="section-head section-head-plain">
            <div>
              <h2>刷新高峰预览</h2>
              <p>按 5 分钟桶展示账号刷新集中点。</p>
            </div>
            <BarChart3 size={20} aria-hidden="true" />
          </div>
          <div className="peak-list">
            {peakBuckets.length === 0 ? (
              <div className="empty-preview">暂无刷新时间数据</div>
            ) : (
              peakBuckets.map((bucket) => (
                <div className="peak-row" key={bucket.bucket}>
                  <span className="bucket-label">{bucket.bucket}</span>
                  <strong>{formatInteger(getBucketTotal(bucket))} 个</strong>
                  <span>5h {formatInteger(bucket.fiveHourAccounts.length)} / 周 {formatInteger(bucket.weeklyAccounts.length)}</span>
                </div>
              ))
            )}
          </div>
        </article>
      </section>
    </div>
  );
}

function AccountsPage({ latest }: { latest: LatestPayload }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [planFilter, setPlanFilter] = useState<PlanFilter>('all');
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [accountPage, setAccountPage] = useState(1);
  const [accountPageSize, setAccountPageSize] = useState(25);

  const filteredRows = useMemo(
    () => filterAccountRows(latest.accounts, search, statusFilter, planFilter, issuesOnly),
    [issuesOnly, latest.accounts, planFilter, search, statusFilter],
  );
  const filteredStats = useMemo(() => getFilteredStats(filteredRows), [filteredRows]);
  const maxPage = Math.max(1, Math.ceil(filteredRows.length / accountPageSize));
  const safeAccountPage = Math.min(accountPage, maxPage);

  const resetPage = () => setAccountPage(1);

  return (
    <section className="workspace-section detail-page">
      <div className="section-head detail-head">
        <div>
          <h2>账号明细</h2>
          <p>仅统计 Codex 主窗口；美元为社区实测折算，非官方账单金额。</p>
        </div>
        <div className="detail-metrics">
          <MetricPill label="当前结果" value={`${formatInteger(filteredStats.total)} 条`} />
          <MetricPill label="启用" value={formatInteger(filteredStats.active)} />
          <MetricPill label="账面计入" value={formatInteger(filteredStats.counted)} />
          <MetricPill label="暂停" value={formatInteger(filteredStats.paused)} />
          <MetricPill label="失败/未知" value={formatInteger(filteredStats.issues)} />
          <MetricPill label="未计价窗口" value={formatInteger(filteredStats.unpriced)} />
        </div>
      </div>

      <div className="filter-bar">
        <label className="search-box">
          <Search size={16} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              resetPage();
            }}
            placeholder="搜索账号名、Account ID 或套餐"
            type="search"
          />
        </label>
        <label className="filter-field">
          <span>状态</span>
          <select
            className="select"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as StatusFilter);
              resetPage();
            }}
          >
            <option value="all">全部</option>
            <option value="active">启用</option>
            <option value="paused">暂停</option>
            <option value="failed">失败</option>
            <option value="unknown">未知</option>
          </select>
        </label>
        <label className="filter-field">
          <span>套餐</span>
          <select
            className="select"
            value={planFilter}
            onChange={(event) => {
              setPlanFilter(event.target.value as PlanFilter);
              resetPage();
            }}
          >
            <option value="all">全部</option>
            <option value="free">普号</option>
            <option value="plus">Plus</option>
            <option value="team">Team</option>
            <option value="pro">Pro</option>
            <option value="unknown">未知</option>
          </select>
        </label>
        <label className="switch filter-switch" title="仅显示失败或未知账号">
          <input
            type="checkbox"
            checked={issuesOnly}
            onChange={(event) => {
              setIssuesOnly(event.target.checked);
              resetPage();
            }}
          />
          <span className="switch-track">
            <SlidersHorizontal size={13} aria-hidden="true" />
          </span>
          <span>仅看异常</span>
        </label>
      </div>

      <AccountTable
        rows={filteredRows}
        page={safeAccountPage}
        pageSize={accountPageSize}
        onPageChange={setAccountPage}
        onPageSizeChange={(size) => {
          setAccountPageSize(size);
          resetPage();
        }}
      />
    </section>
  );
}

function TimelineCell({ bucket, maxCount }: { bucket: RefreshBucket; maxCount: number }) {
  const total = getBucketTotal(bucket);
  const level = total === 0 ? 0 : Math.max(1, Math.ceil((total / Math.max(1, maxCount)) * 5));
  const title = `${bucket.bucket}：合计 ${total}，5h ${bucket.fiveHourAccounts.length}，周 ${bucket.weeklyAccounts.length}`;

  return (
    <div
      className={`timeline-cell timeline-level-${level}`}
      title={title}
      aria-label={title}
      role="img"
    >
      {total > 0 ? <span>{formatInteger(total)}</span> : null}
    </div>
  );
}

function BucketDetailTable({ buckets }: { buckets: RefreshBucket[] }) {
  const [expandedBucket, setExpandedBucket] = useState<string | null>(null);

  return (
    <div className="table-wrap">
      <table className="bucket-table">
        <thead>
          <tr>
            <th>时间桶</th>
            <th>5h 刷新账号数</th>
            <th>周刷新账号数</th>
            <th>账号预览</th>
            <th>展开</th>
          </tr>
        </thead>
        <tbody>
          {buckets.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty-cell">
                暂无刷新时间分布
              </td>
            </tr>
          ) : (
            buckets.map((bucket) => {
              const isExpanded = expandedBucket === bucket.bucket;
              const accounts = Array.from(new Set([...bucket.fiveHourAccounts, ...bucket.weeklyAccounts]));
              return (
                <tr key={bucket.bucket}>
                  <td>
                    <span className="bucket-label">{bucket.bucket}</span>
                  </td>
                  <td>{formatInteger(bucket.fiveHourAccounts.length)}</td>
                  <td>{formatInteger(bucket.weeklyAccounts.length)}</td>
                  <td className="bucket-preview">
                    <span>5h：{previewAccounts(bucket.fiveHourAccounts)}</span>
                    <span>周：{previewAccounts(bucket.weeklyAccounts)}</span>
                    {isExpanded ? <span className="bucket-full-list">{accounts.join('、') || '-'}</span> : null}
                  </td>
                  <td>
                    <button
                      className="icon-button small-icon-button"
                      title={isExpanded ? '收起账号列表' : '展开账号列表'}
                      onClick={() => setExpandedBucket(isExpanded ? null : bucket.bucket)}
                    >
                      {isExpanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
                    </button>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function RefreshTimesPage({ latest }: { latest: LatestPayload }) {
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<BucketMode>('all');
  const [sort, setSort] = useState<BucketSort>('time');

  const visibleBuckets = useMemo(
    () => filterRefreshBuckets(latest.refreshBuckets, search, mode, sort),
    [latest.refreshBuckets, mode, search, sort],
  );
  const timelineBuckets = useMemo(() => buildTimelineBuckets(visibleBuckets), [visibleBuckets]);
  const maxCount = Math.max(1, ...timelineBuckets.map(getBucketTotal));
  const nonEmptyCount = visibleBuckets.length;
  const totalAccounts = visibleBuckets.reduce((sum, bucket) => sum + getBucketTotal(bucket), 0);

  return (
    <section className="workspace-section refresh-page">
      <div className="section-head detail-head">
        <div>
          <h2>刷新时间分布</h2>
          <p>按本地时间 5 分钟桶聚合；adaptive 模式下可能包含缓存 reset 时间。</p>
        </div>
        <div className="detail-metrics">
          <MetricPill label="有刷新桶" value={`${formatInteger(nonEmptyCount)} 个`} />
          <MetricPill label="合计账号次" value={formatInteger(totalAccounts)} />
          <MetricPill label="排序" value={sort === 'time' ? '按时间' : '按账号数'} />
        </div>
      </div>

      <div className="filter-bar refresh-filter-bar">
        <label className="search-box">
          <Search size={16} aria-hidden="true" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索账号名过滤时间桶"
            type="search"
          />
        </label>
        <div className="segmented-control" aria-label="刷新窗口显示模式">
          <button className={mode === 'all' ? 'active' : ''} onClick={() => setMode('all')}>
            全部
          </button>
          <button className={mode === 'five-hour' ? 'active' : ''} onClick={() => setMode('five-hour')}>
            只看 5h
          </button>
          <button className={mode === 'weekly' ? 'active' : ''} onClick={() => setMode('weekly')}>
            只看周限
          </button>
        </div>
        <div className="segmented-control" aria-label="刷新桶排序方式">
          <button className={sort === 'time' ? 'active' : ''} onClick={() => setSort('time')}>
            按时间
          </button>
          <button className={sort === 'count' ? 'active' : ''} onClick={() => setSort('count')}>
            按账号数
          </button>
        </div>
      </div>

      <div className="timeline-panel">
        <div className="timeline-head">
          <div>
            <h3>24 小时时间轴</h3>
            <p>颜色越深表示该 5 分钟桶内刷新账号越多。</p>
          </div>
          <span>{mode === 'all' ? '全部窗口' : mode === 'five-hour' ? '5h 窗口' : '周限窗口'}</span>
        </div>
        <div className="timeline-scroll">
          <div className="timeline-grid">
            {timelineBuckets.map((bucket) => (
              <TimelineCell key={bucket.bucket} bucket={bucket} maxCount={maxCount} />
            ))}
          </div>
          <div className="timeline-ruler" aria-hidden="true">
            {Array.from({ length: 25 }, (_, hour) => (
              <span key={hour}>{hour.toString().padStart(2, '0')}:00</span>
            ))}
          </div>
        </div>
      </div>

      <BucketDetailTable buckets={visibleBuckets} />
    </section>
  );
}

export function App() {
  const [route, setRoute] = useState<AppRoute>('overview');
  const [booting, setBooting] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [monitorKey, setMonitorKey] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [latest, setLatest] = useState<LatestPayload | null>(null);
  const [selectedCpaId, setSelectedCpaId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [pricingSaving, setPricingSaving] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);

  useEffect(() => {
    const syncRoute = () => {
      const nextRoute = getRouteFromHash();
      if (!nextRoute) {
        window.location.hash = '#/overview';
        setRoute('overview');
        return;
      }
      setRoute(nextRoute);
    };

    syncRoute();
    window.addEventListener('hashchange', syncRoute);
    return () => window.removeEventListener('hashchange', syncRoute);
  }, []);

  const loadLatest = useCallback(async (cpaId?: string | null) => {
    setLoading(true);
    setPageError(null);
    try {
      const payload = await monitorApi.latest(cpaId);
      setLatest(payload);
      setSelectedCpaId(payload.selectedCpaId);
    } catch (error) {
      if (error instanceof ClientApiError && error.status === 401) {
        setAuthenticated(false);
        setLatest(null);
      } else {
        setPageError(error instanceof Error ? error.message : '加载失败');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    monitorApi
      .session()
      .then((session) => {
        if (!mounted) return;
        setAuthenticated(session.authenticated);
        if (session.authenticated) void loadLatest();
      })
      .catch(() => {
        if (mounted) setAuthenticated(false);
      })
      .finally(() => {
        if (mounted) setBooting(false);
      });
    return () => {
      mounted = false;
    };
  }, [loadLatest]);

  useEffect(() => {
    if (!authenticated || !autoRefresh) return undefined;
    const timer = window.setInterval(() => {
      void loadLatest(selectedCpaId);
    }, PAGE_AUTO_REFRESH_MINUTES * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [authenticated, autoRefresh, loadLatest, selectedCpaId]);

  useEffect(() => {
    if (!authenticated || latest?.collectorState.status !== 'collecting' || !selectedCpaId) return undefined;
    const timer = window.setInterval(() => {
      void loadLatest(selectedCpaId);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [authenticated, latest?.collectorState.status, loadLatest, selectedCpaId]);

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!monitorKey.trim()) {
      setLoginError('请输入 Monitor Key。');
      return;
    }
    setLoginLoading(true);
    setLoginError(null);
    try {
      await monitorApi.login(monitorKey.trim());
      setAuthenticated(true);
      setMonitorKey('');
      await loadLatest();
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : '登录失败');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    await monitorApi.logout();
    setAuthenticated(false);
    setLatest(null);
  };

  const handleSmartCollect = async () => {
    if (!selectedCpaId) return;
    setLoading(true);
    setPageError(null);
    try {
      const payload = await monitorApi.refresh(selectedCpaId, { coverageMode: 'full-rate-limited' });
      setLatest(payload);
      setSelectedCpaId(payload.selectedCpaId);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '智能采集启动失败');
    } finally {
      setLoading(false);
    }
  };

  const handleSavePricing = async (profile: PricingProfile) => {
    setPricingSaving(true);
    setPricingError(null);
    try {
      await monitorApi.savePricing(profile);
      await loadLatest(selectedCpaId);
      setPricingOpen(false);
    } catch (error) {
      setPricingError(error instanceof Error ? error.message : '保存价格表失败');
    } finally {
      setPricingSaving(false);
    }
  };

  if (booting) {
    return (
      <main className="login-shell">
        <div className="login-panel loading-panel">
          <RefreshCw size={24} className="spin" aria-hidden="true" />
          <strong>正在连接监控服务</strong>
        </div>
      </main>
    );
  }

  if (!authenticated) {
    return (
      <LoginPanel
        monitorKey={monitorKey}
        error={loginError}
        loading={loginLoading}
        onChange={setMonitorKey}
        onSubmit={handleLogin}
      />
    );
  }

  const pricingProfile = latest?.pricingProfile ?? DEFAULT_PRICING_PROFILE;
  const selectedTarget = latest?.targets.find((target) => target.id === selectedCpaId);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-main">
          <div>
            <p className="eyebrow">CPA Codex Account Pool</p>
            <h1>额度监控</h1>
            <div className="connection-line">
              <Database size={15} aria-hidden="true" />
              <span>{selectedTarget?.apiBase ?? '-'}</span>
              <span className="dot-separator">/</span>
              <span>上次采集 {formatTime(latest?.snapshot?.capturedAt)}</span>
              <span className="dot-separator">/</span>
              <span>{pricingProfile.sourceLabel}</span>
            </div>
          </div>
          <PageNav route={route} />
        </div>

        <div className="actions topbar-actions">
          <select
            className="select target-select"
            value={selectedCpaId}
            onChange={(event) => void loadLatest(event.target.value)}
            aria-label="选择 CPA"
          >
            {(latest?.targets ?? []).map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
              </option>
            ))}
          </select>
          <button
            className="button button-primary action-with-note"
            title="对当前 CPA 的启用账号按限速错峰补齐 usage，不集中请求全部账号。"
            onClick={() => void handleSmartCollect()}
            disabled={loading}
          >
            <span className="action-main">
              <RefreshCw size={16} className={loading ? 'spin' : undefined} aria-hidden="true" />
              <span>{loading ? '采集中' : '智能采集'}</span>
            </span>
            <span className="action-note">全池错峰补齐</span>
          </button>
          <label className="switch action-with-note" title={`每 ${PAGE_AUTO_REFRESH_MINUTES} 分钟刷新页面展示数据，不触发账号 usage 采集`}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            <span className="switch-track">
              {autoRefresh ? <Play size={13} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
            </span>
            <span className="action-text">
              <span>页面自动刷新</span>
              <span className="action-note">不请求 usage</span>
            </span>
          </label>
          <button className="icon-button" title="价格表配置" onClick={() => setPricingOpen((value) => !value)}>
            <Settings size={17} aria-hidden="true" />
          </button>
          <button className="icon-button" title="退出监控服务" onClick={() => void handleLogout()}>
            <KeyRound size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      {pageError ? (
        <div className="page-alert" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <span>{pageError}</span>
        </div>
      ) : null}

      {pricingOpen ? (
        <PricingPanel
          key={pricingProfile.updatedAt}
          profile={pricingProfile}
          saving={pricingSaving}
          error={pricingError}
          onClose={() => setPricingOpen(false)}
          onSave={handleSavePricing}
        />
      ) : null}

      {latest ? (
        <>
          {route === 'overview' ? <OverviewPage latest={latest} /> : null}
          {route === 'accounts' ? <AccountsPage latest={latest} /> : null}
          {route === 'refresh-times' ? <RefreshTimesPage latest={latest} /> : null}
        </>
      ) : (
        <section className="workspace-section empty-state">
          <RefreshCw size={22} className={loading ? 'spin' : undefined} aria-hidden="true" />
          <strong>{loading ? '正在加载数据' : '暂无采集数据'}</strong>
        </section>
      )}
    </main>
  );
}
