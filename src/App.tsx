import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  Clock,
  LayoutDashboard,
  ListChecks,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Square,
  Trash2,
  Wifi,
  X,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  monitorApi,
  type CollectorSettings,
  type CpaTargetConfig,
  type EmailAlertSettings,
  type SaveCollectorSettings,
  type SaveEmailAlertSettings,
  type SaveTargetInput,
} from './clientApi';
import type { AccountQuotaRow, AccountQuotaStatus, LatestPayload, PlanKey, PricingProfile, RiskTone } from './shared/domain';
import { DEFAULT_PRICING_PROFILE, formatUsd, getPlanLabel, normalizePricingProfile } from './shared/pricing';

const PAGE_AUTO_REFRESH_MS = 30_000;
const HOUR_MS = 60 * 60 * 1000;

type AppModule = 'overview' | 'accounts' | 'settings';
type AlertSummary = { enabled: boolean; recipients: number; ready: boolean; loading: boolean };
type SettingsDialog = 'cpa' | 'collector' | 'pricing' | 'alert' | null;
type CpaDialogMode = 'create' | 'manage';
type TargetDraft = SaveTargetInput;
type AccountPlanFilter = PlanKey | 'all';
type AccountStatusFilter = AccountQuotaStatus | 'all';
type AccountActionKind = 'refresh' | 'toggle' | 'delete';
type AccountActionState = { key: string; action: AccountActionKind } | null;
const PLAN_ORDER: Array<Exclude<PlanKey, 'unknown'>> = ['free', 'plus', 'team', 'pro'];

const ACCOUNT_PLAN_FILTERS: Array<{ value: AccountPlanFilter; label: string }> = [
  { value: 'all', label: '全部套餐' },
  ...PLAN_ORDER.map((planKey) => ({ value: planKey, label: getPlanLabel(planKey) })),
  { value: 'unknown', label: '未知套餐' },
];

const ACCOUNT_STATUS_FILTERS: Array<{ value: AccountStatusFilter; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '启用' },
  { value: 'paused', label: '暂停' },
  { value: 'failed', label: '失败' },
  { value: 'unknown', label: '未知' },
];

const ACCOUNT_ROW_COLLATOR = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

const MODULES: Array<{ id: AppModule; label: string; icon: ReactNode }> = [
  {
    id: 'overview',
    label: '总览',
    icon: <LayoutDashboard size={16} aria-hidden="true" />,
  },
  {
    id: 'accounts',
    label: '账号明细',
    icon: <ListChecks size={16} aria-hidden="true" />,
  },
  {
    id: 'settings',
    label: '设置',
    icon: <Settings size={16} aria-hidden="true" />,
  },
];

const DEFAULT_EMAIL_SETTINGS: EmailAlertSettings = {
  enabled: false,
  recipients: [],
  minTone: 'warn',
  accountIssueThreshold: 1,
  cooldownMinutes: 30,
  softIssueCooldownMinutes: 720,
  timeoutSeconds: 10,
  maxMessageChars: 4000,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  smtpUsername: '',
  smtpFrom: '',
  hasSmtpPassword: false,
};

const DEFAULT_COLLECTOR_SETTINGS: CollectorSettings = {
  autoCollectEnabled: true,
  collectUsageTickSeconds: 300,
  collectUsageMaxRequestsPerMinute: 30,
  collectUsageMode: 'full',
  collectConcurrency: 3,
  collectManualConcurrency: 8,
};

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

function formatAge(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  const minutes = Math.floor(value / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatSupportHours(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '样本不足';
  return `${value.toFixed(1)} 小时`;
}

function getCapacityStatusLabel(latest: LatestPayload): string {
  const capacity = latest.capacity;
  if (capacity.status === 'ready') return '充足';
  if (capacity.status === 'tight') return '紧张';
  if (capacity.status === 'untrusted') return '样本不足';
  if (capacity.status === 'updating') return '更新中';
  if (capacity.status === 'collecting') return '采集中';
  return '等待采集';
}

function getCapacityStatusToneClass(latest: LatestPayload): string {
  const { capacity, risk } = latest;
  if (capacity.status === 'tight' || risk.tone === 'critical') return 'snapshot-primary-critical';
  if (risk.tone === 'warn' || risk.tone === 'watch' || capacity.status === 'untrusted') return 'snapshot-primary-watch';
  if (capacity.status === 'ready') return 'snapshot-primary-ready';
  return 'snapshot-primary-muted';
}

function hasCapacityCoverageGap(capacity: LatestPayload['capacity']): boolean {
  return capacity.enabledAccounts > 0 && capacity.includedAccounts < capacity.enabledAccounts;
}

function getCapacityCoverageLabel(capacity: LatestPayload['capacity']): string {
  if (capacity.enabledAccounts <= 0) return '无启用账号';
  return `可测容量 ${formatInteger(capacity.includedAccounts)}/${formatInteger(capacity.enabledAccounts)} 账号`;
}

function getCapacityCoverageShortLabel(capacity: LatestPayload['capacity']): string {
  if (capacity.enabledAccounts <= 0) return '无启用账号';
  return `可测 ${formatInteger(capacity.includedAccounts)}/${formatInteger(capacity.enabledAccounts)}`;
}

function hasCapacityBaseline(capacity: LatestPayload['capacity']): boolean {
  return typeof capacity.snapshotCapturedAt === 'number' && Number.isFinite(capacity.snapshotCapturedAt);
}

function hasPartialCapacityBaseline(capacity: LatestPayload['capacity']): boolean {
  return hasCapacityBaseline(capacity) && !capacity.freshComplete;
}

function getExcludedCapacityLabel(capacity: LatestPayload['capacity']): string {
  return `${formatInteger(Math.max(0, capacity.excludedAccounts))} 个异常未计入容量`;
}

function isSoftQuotaWindowIssue(row: AccountQuotaRow): boolean {
  const error = row.error?.trim() ?? '';
  return error.startsWith('缺少 ') && error.endsWith('主窗口额度数据');
}

function isDeactivatedWorkspaceIssue(row: AccountQuotaRow): boolean {
  return (row.error ?? '').includes('deactivated_workspace');
}

function getCapacityExcludedIssueRows(latest: LatestPayload): AccountQuotaRow[] {
  return latest.accounts.filter((row) => !row.disabled && isIssueRow(row));
}

function hasIssueOnlyCapacityExclusion(latest: LatestPayload): boolean {
  const excluded = Math.max(0, latest.capacity.excludedAccounts);
  if (!hasCapacityBaseline(latest.capacity) || !hasCapacityCoverageGap(latest.capacity) || excluded <= 0) return false;
  if (latest.capacity.includedAccounts <= 0) return false;
  return getCapacityExcludedIssueRows(latest).length >= excluded;
}

function getCapacityExcludedIssueLabel(latest: LatestPayload): string {
  const excluded = Math.max(0, latest.capacity.excludedAccounts);
  const issueRows = getCapacityExcludedIssueRows(latest);
  const quotaWindowIssues = issueRows.filter(isSoftQuotaWindowIssue).length;
  const deactivatedWorkspaceIssues = issueRows.filter(isDeactivatedWorkspaceIssue).length;

  if (deactivatedWorkspaceIssues >= excluded) {
    return `${formatInteger(excluded)} 个停用工作区账号已排除`;
  }
  if (quotaWindowIssues >= excluded) {
    return `${formatInteger(excluded)} 个额度显示异常已排除`;
  }
  if (quotaWindowIssues + deactivatedWorkspaceIssues >= excluded) {
    return `${formatInteger(excluded)} 个已知异常账号已排除`;
  }
  return `${formatInteger(excluded)} 个异常账号已排除`;
}

function getCapacityTightDetail(latest: LatestPayload): string {
  const detail = latest.risk.detail.trim();
  if ((latest.risk.tone === 'warn' || latest.risk.tone === 'critical') && detail) return detail;
  if (latest.capacity.estimatedDepletionAt) {
    return `按当前消耗趋势估算，容量预计在 ${formatDateTime(latest.capacity.estimatedDepletionAt)} 前后耗尽。`;
  }
  return '按当前消耗趋势估算，剩余可调度容量偏紧。';
}

function getCapacityStatusDetail(latest: LatestPayload): string {
  const capacity = latest.capacity;
  const collectorState = latest.collectorState;
  if (capacity.status === 'collecting') {
    return `本轮 ${collectorState.progressCompletedAccounts ?? 0}/${collectorState.progressTotalAccounts ?? 0}`;
  }
  if (capacity.status === 'waiting') {
    return hasCapacityBaseline(capacity) ? '容量快照已过期，等待下一轮可测采集' : '等待可测 fresh 全量快照';
  }
  if (capacity.status === 'tight') return getCapacityTightDetail(latest);
  if (hasPartialCapacityBaseline(capacity)) {
    if (hasIssueOnlyCapacityExclusion(latest)) {
      return `${getCapacityCoverageLabel(capacity)} · ${getCapacityExcludedIssueLabel(latest)} · 按剔除后账号监控`;
    }
    return `部分 fresh · ${getCapacityCoverageLabel(capacity)} · ${getExcludedCapacityLabel(capacity)}`;
  }
  if (hasCapacityCoverageGap(capacity)) {
    if (hasIssueOnlyCapacityExclusion(latest)) {
      return `${getCapacityCoverageLabel(capacity)} · ${getCapacityExcludedIssueLabel(latest)} · 按剔除后账号监控`;
    }
    const sample = capacity.hourlyBurnUsd === null || capacity.burnRateBasis === 'insufficient' ? ' · 消耗样本不足' : '';
    return `${getCapacityCoverageLabel(capacity)} · 部分账号缺少完整容量窗口${sample}`;
  }
  if (capacity.hourlyBurnUsd === null || capacity.burnRateBasis === 'insufficient') return '消耗样本不足，等待两轮成功采集';
  if (capacity.status === 'updating') {
    return `沿用 ${formatAge(capacity.snapshotAgeMs)} 完整快照 · 本轮 ${collectorState.progressCompletedAccounts ?? 0}/${collectorState.progressTotalAccounts ?? 0}`;
  }
  if (capacity.status === 'untrusted') return `等待更多可用样本 · ${getCapacityCoverageShortLabel(capacity)}`;
  return `按保守消耗 · ${getCapacityCoverageLabel(capacity)}`;
}

function getCapacityValueLabel(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '等待完整采集';
  return formatUsd(value);
}

function getCurrentUsableLabel(capacity: LatestPayload['capacity']): string {
  if (capacity.freshComplete && capacity.includedAccounts === 0) return '无可测账号';
  return getCapacityValueLabel(capacity.currentUsableUsd);
}

function getCapacitySnapshotDetail(latest: LatestPayload): string {
  const capacity = latest.capacity;
  if (!hasCapacityBaseline(capacity)) return '等待可测容量基线';
  if (hasPartialCapacityBaseline(capacity)) {
    if (hasIssueOnlyCapacityExclusion(latest)) {
      return `异常已剔除 · ${getCapacityCoverageShortLabel(capacity)} · ${getCapacityExcludedIssueLabel(latest)} · ${formatAge(capacity.snapshotAgeMs)}`;
    }
    return `部分 fresh · ${getCapacityCoverageShortLabel(capacity)} · ${formatAge(capacity.snapshotAgeMs)}`;
  }
  if (capacity.enabledAccounts > 0) return `${getCapacityCoverageLabel(capacity)} · ${formatAge(capacity.snapshotAgeMs)}`;
  return `完整快照 ${formatAge(capacity.snapshotAgeMs)}`;
}

function getHealthSnapshotNote(latest: LatestPayload): string {
  const capacity = latest.capacity;
  if (!hasCapacityBaseline(capacity)) return '等待可测 fresh';
  const coverage = capacity.enabledAccounts > 0
    ? getCapacityCoverageShortLabel(capacity)
    : '无启用账号';
  if (hasPartialCapacityBaseline(capacity)) {
    if (hasIssueOnlyCapacityExclusion(latest)) {
      return `异常已剔除 · ${coverage} · ${getCapacityExcludedIssueLabel(latest)} · ${formatDateTime(capacity.snapshotCapturedAt)}`;
    }
    return `部分 fresh · ${coverage} · ${getExcludedCapacityLabel(capacity)} · ${formatDateTime(capacity.snapshotCapturedAt)}`;
  }
  return `完整 fresh · ${coverage} · ${formatDateTime(capacity.snapshotCapturedAt)}`;
}

function getCapacityCurveEmptyLabel(capacity: LatestPayload['capacity']): string {
  if (!hasCapacityBaseline(capacity)) return '等待可测 fresh 快照';
  if (capacity.status === 'waiting') return '容量快照已过期';
  return '等待可测容量窗口';
}

function getForecastValueLabel(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '样本不足';
  return formatUsd(value);
}

function getHourlyBurnLabel(capacity: LatestPayload['capacity']): string {
  const observed = capacity.observedHourlyBurnUsd ?? capacity.hourlyBurnUsd;
  if (typeof observed !== 'number' || !Number.isFinite(observed)) return '样本不足';
  return `${formatUsd(observed)} / h`;
}

function getHourlyBurnDetail(latest: LatestPayload): string {
  const capacity = latest.capacity;
  if (capacity.hourlyBurnUsd === null || capacity.burnRateBasis === 'insufficient') return '需要两轮成功采集';
  const effective = capacity.effectiveHourlyBurnUsd;
  const warning = typeof effective === 'number' && Number.isFinite(effective)
    ? `预警按 ${formatUsd(effective)} / h`
    : '等待保守预警';
  return `${getBurnRateBasisLabel(capacity.burnRateBasis)} · ${warning} · 覆盖 ${formatBurnCoveragePercent(capacity)}`;
}

function getSupportLabel(capacity: LatestPayload['capacity']): string {
  if (capacity.supportStatus === 'idle') return '低消耗';
  if (capacity.supportStatus === 'beyond-5h') return '> 5h';
  if (capacity.supportStatus === 'within-5h') return formatSupportHours(capacity.supportHours);
  return '样本不足';
}

function getSupportDetail(capacity: LatestPayload['capacity']): string {
  if (capacity.supportStatus === 'insufficient-sample') return '需要两轮成功采集';
  if (capacity.supportStatus === 'idle') return '近期低消耗';
  if (capacity.supportStatus === 'within-5h') {
    return capacity.estimatedDepletionAt ? `预计耗尽 ${formatDateTime(capacity.estimatedDepletionAt)}` : '';
  }
  return '可覆盖 5h 预测窗口';
}

function getProjectedMarginLabel(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '样本不足';
  if (value < 0) return `缺 ${formatUsd(Math.abs(value))}`;
  return formatUsd(value);
}

function getFiveHourCapacityMinimum(capacity: LatestPayload['capacity']): LatestPayload['capacity']['fiveHourTimeline'][number] | null {
  return capacity.fiveHourTimeline.reduce<LatestPayload['capacity']['fiveHourTimeline'][number] | null>((lowest, point) => {
    if (!lowest || point.usableUsd < lowest.usableUsd) return point;
    return lowest;
  }, null);
}

function getBurnRateBasisLabel(value: LatestPayload['capacity']['burnRateBasis']): string {
  if (value === 'three-hour') return '近 3h 均速';
  if (value === 'one-hour') return '近 1h 提速';
  if (value === 'thirty-minute-spike') return '近 30m 突增';
  if (value === 'zero') return '低消耗';
  return '样本不足';
}

function formatBurnCoveragePercent(capacity: LatestPayload['capacity']): string {
  return Number.isFinite(capacity.consumptionCoveragePercent) ? `${Math.round(capacity.consumptionCoveragePercent)}%` : '-';
}

function getForecastBurnCaption(capacity: LatestPayload['capacity']): string {
  const effective = capacity.effectiveHourlyBurnUsd;
  if (typeof effective !== 'number' || !Number.isFinite(effective)) return '等待消耗样本';
  return `${getBurnRateBasisLabel(capacity.burnRateBasis)} · 按保守 ${formatUsd(effective)} / h`;
}

function getCapacityTimelineNow(capacity: LatestPayload['capacity']): number | null {
  const point = capacity.fiveHourTimeline[0];
  if (typeof point?.at === 'number' && Number.isFinite(point.at)) return point.at;
  return null;
}

function getNextHourReleaseEvents(capacity: LatestPayload['capacity']): LatestPayload['capacity']['twentyFourHourSummary']['releaseEvents'] {
  const now = getCapacityTimelineNow(capacity);
  if (now === null) return [];
  const horizon = now + HOUR_MS;
  return capacity.twentyFourHourSummary.releaseEvents.filter((event) => event.at > now && event.at <= horizon);
}

function getNextHourReleaseLabel(capacity: LatestPayload['capacity']): string {
  const releasedUsd = getNextHourReleaseEvents(capacity).reduce((total, event) => total + Math.max(0, event.releasedUsd), 0);
  return formatUsd(releasedUsd);
}

function getNextHourReleaseDetail(capacity: LatestPayload['capacity']): string {
  const events = getNextHourReleaseEvents(capacity);
  if (events.length === 0) return '未来 1h 暂无新增';
  const nearestAt = events.reduce((nearest, event) => Math.min(nearest, event.at), Number.POSITIVE_INFINITY);
  return `最近 ${formatDateTime(nearestAt)} 新增`;
}

function getObservedBurnSummary(latest: LatestPayload): string {
  const enabledAccounts = latest.capacity.enabledAccounts || latest.snapshot?.collection.enabledAccounts || 0;
  const basisAccounts = getBurnBasisComparableAccounts(latest);
  const observed = latest.capacity.observedHourlyBurnUsd ?? latest.capacity.hourlyBurnUsd;
  if (typeof observed !== 'number' || !Number.isFinite(observed)) return `已观测：样本不足 · 覆盖 0/${formatInteger(enabledAccounts)} 账号`;
  return `已观测：${getBurnRateBasisLabel(latest.capacity.burnRateBasis)} ${formatUsd(observed)} / h · 近 1h ${formatNullableHourlyBurn(latest.risk.oneHourBurnUsd)} · 覆盖 ${formatInteger(basisAccounts)}/${formatInteger(enabledAccounts)} 账号`;
}

function formatNullableHourlyBurn(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '样本不足';
  return `${formatUsd(value)} / h`;
}

function getBurnBasisComparableAccounts(latest: LatestPayload): number {
  const enabledAccounts = latest.capacity.enabledAccounts || latest.snapshot?.collection.enabledAccounts || 0;
  const clampComparable = (value: number): number => {
    if (!Number.isFinite(value) || value <= 0 || enabledAccounts <= 0) return 0;
    return Math.min(value, enabledAccounts);
  };
  const basis = latest.capacity.burnRateBasis;
  if (basis === 'three-hour') return clampComparable(latest.consumption.threeHours.comparableSeries);
  if (basis === 'one-hour') return clampComparable(latest.consumption.oneHour.comparableSeries);
  if (basis === 'thirty-minute-spike') return clampComparable(latest.consumption.thirtyMinutes.comparableSeries);
  if (basis === 'zero') {
    return clampComparable(Math.max(
      latest.consumption.threeHours.comparableSeries,
      latest.consumption.oneHour.comparableSeries,
      latest.consumption.thirtyMinutes.comparableSeries,
    ));
  }
  return 0;
}

function getFiveHourHorizonPoint(capacity: LatestPayload['capacity']): LatestPayload['capacity']['fiveHourTimeline'][number] | null {
  if (capacity.fiveHourTimeline.length === 0) return null;
  return capacity.fiveHourTimeline[capacity.fiveHourTimeline.length - 1] ?? null;
}

function getFiveHourFormula(capacity: LatestPayload['capacity']): string {
  const horizonPoint = getFiveHourHorizonPoint(capacity);
  return `${getProjectedMarginLabel(capacity.projectedFiveHourMarginUsd)} = ${getCapacityValueLabel(horizonPoint?.usableUsd)} - ${getForecastValueLabel(capacity.projectedFiveHourSpendUsd)}`;
}

function getEmailConfigIssues(settings: EmailAlertSettings | null): string[] {
  if (!settings) return [];
  const issues: string[] = [];
  if (!settings.enabled) issues.push('邮箱预警未开启');
  if (settings.recipients.length === 0) issues.push('收件人未配置');
  if (!settings.smtpHost.trim()) issues.push('SMTP 服务器未配置');
  if (!settings.smtpUsername.trim()) issues.push('SMTP 用户名未配置');
  if (!settings.hasSmtpPassword) issues.push('SMTP 密码未保存');
  if (!settings.smtpFrom.trim()) issues.push('发件人未配置');
  return issues;
}

function formatEmailIssueSummary(issues: string[]): string {
  if (issues.length === 0) return '邮箱预警已就绪';
  const preview = issues.slice(0, 3).join('、');
  return issues.length > 3 ? `${preview} 等 ${formatInteger(issues.length)} 项` : preview;
}

function getEmailToneLabel(tone: EmailAlertSettings['minTone'] | null | undefined): string {
  if (tone === 'critical') return '严重';
  if (tone === 'watch') return '观察及以上';
  return '警告及以上';
}

function getCollectorStatusLabel(status: LatestPayload['collectorState']['status']): string {
  if (status === 'collecting') return '采集中';
  if (status === 'ok') return '正常';
  if (status === 'error') return '异常';
  return '空闲';
}

function getCollectorProgress(state: LatestPayload['collectorState'] | null | undefined): {
  running: boolean;
  label: string;
  percent: number | null;
} {
  if (state?.status !== 'collecting') {
    return { running: false, label: '立即采集', percent: null };
  }
  const total = state.progressTotalAccounts;
  const completed = state.progressCompletedAccounts ?? 0;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
    return { running: true, label: '采集中', percent: null };
  }
  const safeCompleted = Math.min(Math.max(0, completed), total);
  return {
    running: true,
    label: `采集中 ${formatInteger(safeCompleted)}/${formatInteger(total)}`,
    percent: Math.round((safeCompleted / total) * 100),
  };
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

function getAccountUsableUsd(row: AccountQuotaRow): number | null {
  const fiveHourUsd = row.fiveHour?.remainingUsd;
  const weeklyUsd = row.weekly?.remainingUsd;
  if (typeof fiveHourUsd !== 'number' || typeof weeklyUsd !== 'number') return null;
  return Math.max(0, Math.min(fiveHourUsd, weeklyUsd));
}

function getQuotaSourceLabel(row: AccountQuotaRow): string {
  if (row.quotaSource === 'fresh') return 'fresh';
  if (row.quotaSource === 'cached') return '缓存';
  if (row.quotaSource === 'backoff') return '退避';
  if (row.quotaSource === 'pending') return '等待';
  if (row.quotaSource === 'paused') return '暂停';
  return '失败';
}

function getAccountTypeLabel(row: AccountQuotaRow): string {
  return getPlanLabel(row.normalizedPlan, row.planType);
}

function compactText(value: string, maxLength = 36): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function getAccountCollectionNote(row: AccountQuotaRow): string | null {
  if (row.quotaSource === 'backoff') {
    if (row.backoffUntil) return `恢复 ${formatDateTime(row.backoffUntil)}`;
    return row.error ? compactText(row.error) : '本轮暂停采集';
  }
  if (row.error) return compactText(row.error);
  if (row.requestHeaderSource === 'cpa-metadata') return 'CPA 元数据请求头';
  return null;
}

function getAccountFiveHourResetMs(row: AccountQuotaRow): number | null {
  const resetAtMs = row.fiveHour?.resetAtMs;
  return typeof resetAtMs === 'number' && Number.isFinite(resetAtMs) ? resetAtMs : null;
}

function compareAccountsByFiveHourReset(left: AccountQuotaRow, right: AccountQuotaRow): number {
  const leftResetAt = getAccountFiveHourResetMs(left);
  const rightResetAt = getAccountFiveHourResetMs(right);
  if (leftResetAt !== null && rightResetAt !== null && leftResetAt !== rightResetAt) return leftResetAt - rightResetAt;
  if (leftResetAt !== null && rightResetAt === null) return -1;
  if (leftResetAt === null && rightResetAt !== null) return 1;
  const nameDelta = ACCOUNT_ROW_COLLATOR.compare(left.name, right.name);
  if (nameDelta !== 0) return nameDelta;
  return ACCOUNT_ROW_COLLATOR.compare(left.accountKey, right.accountKey);
}

function getAccountSearchHaystack(row: AccountQuotaRow): string {
  return [row.name, row.accountId ?? '', row.accountKey, row.provider].join(' ').toLocaleLowerCase();
}

function getAccountAuthFileName(row: AccountQuotaRow): string {
  return row.authFileName?.trim() || row.name;
}

function getAccountRowKey(row: AccountQuotaRow): string {
  return `${row.cpaId}:${row.authFileName ?? row.authId ?? row.accountKey}:${row.name}`;
}

function parseRecipientInput(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function createEmptyTargetDraft(): TargetDraft {
  return {
    id: null,
    name: '',
    apiBase: '',
    enabled: true,
    managementKey: '',
  };
}

function createDraftFromTarget(target: CpaTargetConfig): TargetDraft {
  return {
    id: target.id,
    name: target.name,
    apiBase: target.apiBase,
    enabled: target.enabled,
    managementKey: '',
  };
}

function TargetSetupPanel({ onConfigured }: { onConfigured: () => Promise<void> }) {
  const [draft, setDraft] = useState<TargetDraft>(() => createEmptyTargetDraft());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const updateDraft = <K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
    setSuccess(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await monitorApi.testTargetConnection(draft);
      setSuccess(`连接可用：${formatInteger(result.codexAuthFiles)} 个 Codex / ${formatInteger(result.totalAuthFiles)} 个授权文件`);
    } catch (error) {
      setError(error instanceof Error ? error.message : '连接测试失败');
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await monitorApi.saveTarget(draft);
      await onConfigured();
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存 CPA 配置失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="setup-shell">
      <section className="setup-panel" aria-labelledby="setup-title">
        <div className="login-mark">
          <ShieldCheck size={20} aria-hidden="true" />
        </div>
        <p className="eyebrow">NeoQuota Monitor</p>
        <h1 id="setup-title">配置第一个 CPA</h1>
        <p className="login-copy">客户端会把 Management Key 保存到系统钥匙串，配置完成后由桌面后台直接采集账号池额度。</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            <span>CPA 名称</span>
            <input
              value={draft.name}
              onChange={(event) => updateDraft('name', event.target.value)}
              placeholder="Main CPA"
              autoComplete="off"
            />
          </label>
          <label>
            <span>CPA API Base</span>
            <input
              value={draft.apiBase}
              onChange={(event) => updateDraft('apiBase', event.target.value)}
              placeholder="http://127.0.0.1:8398"
              autoComplete="url"
            />
          </label>
          <label>
            <span>Management Key</span>
            <input
              value={draft.managementKey ?? ''}
              onChange={(event) => updateDraft('managementKey', event.target.value)}
              placeholder="输入 CPA management key"
              type="password"
              autoComplete="new-password"
            />
          </label>

          {error ? (
            <div className="inline-alert" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}

          {success ? (
            <div className="inline-success" role="status">
              <CheckCircle2 size={16} aria-hidden="true" />
              <span>{success}</span>
            </div>
          ) : null}

          <div className="form-actions form-actions-split">
            <button className="button button-secondary" type="button" onClick={() => void handleTest()} disabled={testing || saving}>
              {testing ? <RefreshCw size={16} className="spin" aria-hidden="true" /> : <Wifi size={16} aria-hidden="true" />}
              <span>{testing ? '测试中' : '测试连接'}</span>
            </button>
            <button className="button button-primary" type="submit" disabled={saving || testing}>
              {saving ? <RefreshCw size={16} className="spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              <span>{saving ? '保存中' : '保存并开始监控'}</span>
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

function StatusPill({ tone, label }: { tone: RiskTone | 'ok' | 'error' | 'muted'; label: string }) {
  return <span className={`status-pill status-pill-${tone}`}>{label}</span>;
}

function HealthRow({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="health-row">
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{note}</em>
    </div>
  );
}

function CapacityCurve({
  points,
  emptyLabel = '等待完整 fresh 快照',
}: {
  points: LatestPayload['capacity']['fiveHourTimeline'];
  emptyLabel?: string;
}) {
  const maxProjected = Math.max(1, ...points.map((point) => Math.max(0, point.projectedRemainingUsd ?? point.usableUsd)));

  return (
    <div className="capacity-chart" aria-label="未来 5 小时保守预计余量曲线">
      {points.length === 0 ? (
        <div className="empty-chart">
          <Clock size={18} aria-hidden="true" />
          <span>{emptyLabel}</span>
        </div>
      ) : (
        points.map((point) => (
          <div className="chart-column" key={point.offsetMinutes}>
            <div className="chart-track">
              <div
                className={`chart-bar ${(point.projectedRemainingUsd ?? 0) < 0 ? 'chart-bar-negative' : ''}`}
                style={{ height: `${Math.max(8, Math.round((Math.max(0, point.projectedRemainingUsd ?? point.usableUsd) / maxProjected) * 100))}%` }}
              />
            </div>
            <span>{point.offsetMinutes === 0 ? '现在' : `+${Math.round(point.offsetMinutes / 60)}h`}</span>
            <strong>{getProjectedMarginLabel(point.projectedRemainingUsd ?? point.usableUsd)}</strong>
          </div>
        ))
      )}
    </div>
  );
}

function OverviewModule({
  latest,
  alertSummary,
  emailIssues,
  onOpenSettings,
}: {
  latest: LatestPayload;
  alertSummary: AlertSummary;
  emailIssues: string[];
  onOpenSettings: () => void;
}) {
  const capacity = latest.capacity;
  const collection = latest.snapshot?.collection;
  const issueCount = latest.accounts.filter(isIssueRow).length;
  const showAttention = !alertSummary.loading && emailIssues.length > 0;
  const fiveHourCapacityMinimum = getFiveHourCapacityMinimum(capacity);

  return (
    <div className="overview-module">
      {showAttention ? (
        <section className="content-card attention-strip attention-strip-watch" aria-label="配置待办">
          <StatusPill tone="watch" label="待配置" />
          <div className="attention-copy">
            <strong>邮箱预警未就绪</strong>
            <span>{formatEmailIssueSummary(emailIssues)}</span>
          </div>
          <button
            className="button button-primary"
            type="button"
            onClick={onOpenSettings}
          >
            <span>配置邮箱预警</span>
          </button>
        </section>
      ) : null}

      <section className="content-card snapshot-card" aria-label="关键指标">
        <div className={`snapshot-metric snapshot-primary ${getCapacityStatusToneClass(latest)}`}>
          <span>容量状态</span>
          <strong>{getCapacityStatusLabel(latest)}</strong>
          <em>{getCapacityStatusDetail(latest)}</em>
        </div>
        <div className="snapshot-metric">
          <span>估算每小时消耗</span>
          <strong>{getHourlyBurnLabel(capacity)}</strong>
          <em>{getHourlyBurnDetail(latest)}</em>
        </div>
        <div className="snapshot-metric">
          <span>当前可调度</span>
          <strong>{getCurrentUsableLabel(capacity)}</strong>
          <em>{getCapacitySnapshotDetail(latest)}</em>
        </div>
        <div className="snapshot-metric">
          <span>预计可撑</span>
          <strong>{getSupportLabel(capacity)}</strong>
          <em>{getSupportDetail(capacity)}</em>
        </div>
        <div className="snapshot-metric">
          <span>未来 1h 新增</span>
          <strong>{getNextHourReleaseLabel(capacity)}</strong>
          <em>{getNextHourReleaseDetail(capacity)}</em>
        </div>
      </section>

      <div className="overview-grid">
        <section className="content-card forecast-card" aria-label="容量预测">
          <div className="card-head">
            <div>
              <p className="eyebrow">Forecast</p>
              <h2>容量预估</h2>
            </div>
            <span className="card-caption">
              {getForecastBurnCaption(capacity)}
            </span>
          </div>

          <CapacityCurve
            points={capacity.fiveHourTimeline}
            emptyLabel={getCapacityCurveEmptyLabel(capacity)}
          />
          <div className="forecast-formula">
            <span>按保守消耗：5h 后预计剩余 = 5h 后账面容量 - 预计 5h 消耗</span>
            <strong>{getFiveHourFormula(capacity)}</strong>
          </div>
          <div className="forecast-caption">
            <span>按保守 5h 消耗 {getForecastValueLabel(capacity.projectedFiveHourSpendUsd)}</span>
            <span>按保守剩余 {getProjectedMarginLabel(capacity.projectedFiveHourMarginUsd)}</span>
            <span>账面 5h 最低 {getCapacityValueLabel(fiveHourCapacityMinimum?.usableUsd)}</span>
            <span>24h 新增 {getCapacityValueLabel(capacity.twentyFourHourSummary.projectedAddedUsableUsd)}</span>
            <span>已观测消耗 {getObservedBurnSummary(latest)}</span>
          </div>
        </section>

        <section className="content-card health-card" aria-label="运行健康">
          <div className="card-head">
            <div>
              <p className="eyebrow">Checks</p>
              <h2>运行检查</h2>
            </div>
            <span className="card-caption">当前 CPA</span>
          </div>

          <div className="health-list">
            <HealthRow
              label="采集"
              value={formatTime(latest.collectorState.nextRunAt)}
              note={`${getCollectorStatusLabel(latest.collectorState.status)} · 本轮 ${latest.collectorState.progressCompletedAccounts ?? 0}/${latest.collectorState.progressTotalAccounts ?? 0}`}
            />
            <HealthRow
              label="快照"
              value={capacity.snapshotAgeMs === null ? '-' : formatAge(capacity.snapshotAgeMs)}
              note={getHealthSnapshotNote(latest)}
            />
            <HealthRow
              label="查询"
              value={collection ? `${formatInteger(collection.freshAccounts)} / ${formatInteger(collection.failedAccounts)}` : '-'}
              note="成功 / 失败"
            />
            <HealthRow
              label="冷却"
              value={collection ? `${formatInteger(collection.backoffAccounts)} 个` : '-'}
              note="403 / 429 / challenge 退避"
            />
            <HealthRow label="账号" value={`${formatInteger(issueCount)} 异常`} note={`${formatInteger(latest.accounts.length)} 个账号`} />
          </div>
        </section>
      </div>
    </div>
  );
}

function AccountStatusBadge({ status }: { status: AccountQuotaStatus }) {
  return <span className={`account-status account-status-${status}`}>{getStatusLabel(status)}</span>;
}

function AccountDetailsModule({
  accounts,
  accountAction,
  refreshDisabled,
  onRefreshAccount,
  onToggleAccount,
  onDeleteAccount,
}: {
  accounts: AccountQuotaRow[];
  accountAction: AccountActionState;
  refreshDisabled: boolean;
  onRefreshAccount: (row: AccountQuotaRow) => Promise<void> | void;
  onToggleAccount: (row: AccountQuotaRow, enabled: boolean) => Promise<void> | void;
  onDeleteAccount: (row: AccountQuotaRow) => Promise<void> | void;
}) {
  const [searchText, setSearchText] = useState('');
  const [planFilter, setPlanFilter] = useState<AccountPlanFilter>('all');
  const [statusFilter, setStatusFilter] = useState<AccountStatusFilter>('all');
  const [issueOnly, setIssueOnly] = useState(false);
  const [withFiveHourResetOnly, setWithFiveHourResetOnly] = useState(false);

  const normalizedSearchText = searchText.trim().toLocaleLowerCase();
  const filtersActive =
    normalizedSearchText !== '' ||
    planFilter !== 'all' ||
    statusFilter !== 'all' ||
    issueOnly ||
    withFiveHourResetOnly;

  const rows = useMemo(() => {
    return accounts
      .filter((row) => {
        if (normalizedSearchText && !getAccountSearchHaystack(row).includes(normalizedSearchText)) return false;
        if (planFilter !== 'all' && row.normalizedPlan !== planFilter) return false;
        if (statusFilter !== 'all' && row.status !== statusFilter) return false;
        if (issueOnly && !isIssueRow(row)) return false;
        if (withFiveHourResetOnly && getAccountFiveHourResetMs(row) === null) return false;
        return true;
      })
      .sort(compareAccountsByFiveHourReset);
  }, [accounts, issueOnly, normalizedSearchText, planFilter, statusFilter, withFiveHourResetOnly]);
  const issueCount = useMemo(() => rows.filter(isIssueRow).length, [rows]);
  const caption = filtersActive
    ? `${formatInteger(issueCount)} 异常 / ${formatInteger(rows.length)} 匹配 / ${formatInteger(accounts.length)} 总计`
    : `${formatInteger(issueCount)} 异常 / ${formatInteger(accounts.length)}`;

  const resetFilters = () => {
    setSearchText('');
    setPlanFilter('all');
    setStatusFilter('all');
    setIssueOnly(false);
    setWithFiveHourResetOnly(false);
  };

  return (
    <section className="content-card accounts-card" aria-label="账号明细">
      <div className="card-head">
        <div>
          <p className="eyebrow">Accounts</p>
          <h2>账号明细</h2>
        </div>
        <span className="card-caption">{caption}</span>
      </div>

      <div className="accounts-filter-bar" aria-label="账号筛选">
        <label className="account-search-field">
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">搜索账号</span>
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="搜索账号、ID、provider"
          />
        </label>
        <label className="account-filter-field">
          <span className="sr-only">套餐</span>
          <select value={planFilter} onChange={(event) => setPlanFilter(event.target.value as AccountPlanFilter)}>
            {ACCOUNT_PLAN_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="account-filter-field">
          <span className="sr-only">状态</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as AccountStatusFilter)}>
            {ACCOUNT_STATUS_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="switch account-filter-toggle">
          <input type="checkbox" checked={issueOnly} onChange={(event) => setIssueOnly(event.target.checked)} />
          <span className="switch-track">{issueOnly ? <CheckCircle2 size={13} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}</span>
          <span>只看异常</span>
        </label>
        <label className="switch account-filter-toggle">
          <input type="checkbox" checked={withFiveHourResetOnly} onChange={(event) => setWithFiveHourResetOnly(event.target.checked)} />
          <span className="switch-track">{withFiveHourResetOnly ? <CheckCircle2 size={13} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}</span>
          <span>有 5h 时间</span>
        </label>
        <button className="button button-secondary account-filter-clear" type="button" onClick={resetFilters} disabled={!filtersActive}>
          <X size={14} aria-hidden="true" />
          <span>清空</span>
        </button>
      </div>

      <div className="account-table-wrap">
        <table className="accounts-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>类型</th>
              <th>状态</th>
              <th>可调度</th>
              <th>5h 剩余</th>
              <th>周限剩余</th>
              <th>5h 重置</th>
              <th>周重置</th>
              <th>采集</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="empty-cell">
                  {accounts.length === 0 ? (
                    '暂无账号数据'
                  ) : (
                    <div className="account-empty-state">
                      <strong>没有匹配账号</strong>
                      <span>调整筛选条件后再试</span>
                      <button className="button button-secondary account-filter-reset-inline" type="button" onClick={resetFilters}>
                        <X size={14} aria-hidden="true" />
                        <span>清空筛选</span>
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const collectionNote = getAccountCollectionNote(row);
                const rowActionKey = getAccountRowKey(row);
                const rowAction = accountAction?.key === rowActionKey ? accountAction.action : null;
                const rowRefreshing = rowAction === 'refresh';
                const rowToggling = rowAction === 'toggle';
                const rowDeleting = rowAction === 'delete';
                const rowActionDisabled = refreshDisabled || accountAction !== null;
                const accountTypeLabel = getAccountTypeLabel(row);
                const authFileName = getAccountAuthFileName(row);
                return (
                  <tr className={isIssueRow(row) ? 'issue-row' : undefined} key={rowActionKey}>
                    <td>
                      <div className="account-name">
                        <div className="account-title-line">
                          <strong title={row.name}>{row.name}</strong>
                        </div>
                        <span>{row.accountId ?? row.provider}</span>
                      </div>
                    </td>
                    <td>
                      <span className={`account-type-badge account-type-${row.normalizedPlan}`} title={`账号类型：${accountTypeLabel}`}>
                        {accountTypeLabel}
                      </span>
                    </td>
                    <td><AccountStatusBadge status={row.status} /></td>
                    <td>{formatUsd(getAccountUsableUsd(row))}</td>
                    <td>{formatUsd(row.fiveHour?.remainingUsd)}</td>
                    <td>{formatUsd(row.weekly?.remainingUsd)}</td>
                    <td>{formatDateTime(row.fiveHour?.resetAtMs)}</td>
                    <td>{formatDateTime(row.weekly?.resetAtMs)}</td>
                    <td>
                      <div className="source-cell">
                        <span className={`source-badge source-${row.quotaSource}`}>{getQuotaSourceLabel(row)}</span>
                        {collectionNote ? <small title={row.error ?? collectionNote}>{collectionNote}</small> : null}
                      </div>
                    </td>
                    <td>
                      <div className="account-action-cell">
                        <button
                          className="icon-button account-refresh-button"
                          type="button"
                          title={`手动刷新 ${row.name}`}
                          aria-label={`手动刷新账号 ${row.name}`}
                          onClick={() => void onRefreshAccount(row)}
                          disabled={rowActionDisabled}
                        >
                          <RefreshCw size={14} className={rowRefreshing ? 'spin' : undefined} aria-hidden="true" />
                        </button>
                        <button
                          className="icon-button account-delete-button"
                          type="button"
                          title={`删除凭证 ${authFileName}`}
                          aria-label={`删除凭证 ${authFileName}`}
                          onClick={() => void onDeleteAccount(row)}
                          disabled={rowActionDisabled}
                        >
                          {rowDeleting ? <RefreshCw size={14} className="spin" aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
                        </button>
                        <label className="switch account-enable-toggle" title={row.disabled ? `启用 ${authFileName}` : `停用 ${authFileName}`}>
                          <input
                            type="checkbox"
                            checked={!row.disabled}
                            onChange={(event) => void onToggleAccount(row, event.target.checked)}
                            disabled={rowActionDisabled}
                            aria-label={`${row.disabled ? '启用' : '停用'}凭证 ${authFileName}`}
                          />
                          <span className="switch-track">
                            {rowToggling ? (
                              <RefreshCw size={12} className="spin" aria-hidden="true" />
                            ) : !row.disabled ? (
                              <CheckCircle2 size={12} aria-hidden="true" />
                            ) : (
                              <Square size={12} aria-hidden="true" />
                            )}
                          </span>
                          <span>启用</span>
                        </label>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CpaTargetsPanel({
  targets,
  onChanged,
  initialMode,
  initialTargetId,
}: {
  targets: CpaTargetConfig[];
  onChanged: () => Promise<void>;
  initialMode: CpaDialogMode;
  initialTargetId: string | null;
}) {
  const initialTarget = initialMode === 'manage'
    ? targets.find((target) => target.id === initialTargetId) ?? targets[0] ?? null
    : null;
  const [draft, setDraft] = useState<TargetDraft>(() => initialTarget ? createDraftFromTarget(initialTarget) : createEmptyTargetDraft());
  const [editingId, setEditingId] = useState<string | null>(() => initialTarget?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | null>(null);

  const editingTarget = useMemo(() => targets.find((target) => target.id === editingId) ?? null, [editingId, targets]);

  const resetDraft = () => {
    setDraft(createEmptyTargetDraft());
    setEditingId(null);
    setError(null);
    setSuccess(null);
  };

  const editTarget = (target: CpaTargetConfig) => {
    setDraft(createDraftFromTarget(target));
    setEditingId(target.id);
    setError(null);
    setSuccess(null);
  };

  const updateDraft = <K extends keyof TargetDraft>(key: K, value: TargetDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
    setSuccess(null);
  };

  const handleTest = async () => {
    setBusy('test');
    setError(null);
    setSuccess(null);
    try {
      const result = await monitorApi.testTargetConnection(draft);
      setSuccess(`连接可用：${formatInteger(result.codexAuthFiles)} 个 Codex / ${formatInteger(result.totalAuthFiles)} 个授权文件`);
    } catch (error) {
      setError(error instanceof Error ? error.message : '连接测试失败');
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy('save');
    setError(null);
    setSuccess(null);
    try {
      await monitorApi.saveTarget(draft);
      await onChanged();
      const message = editingId ? 'CPA 配置已更新' : 'CPA 已添加';
      resetDraft();
      setSuccess(message);
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存 CPA 配置失败');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!editingId) return;
    setBusy('delete');
    setError(null);
    try {
      await monitorApi.deleteTarget(editingId);
      await onChanged();
      resetDraft();
    } catch (error) {
      setError(error instanceof Error ? error.message : '删除 CPA 失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-block settings-panel settings-panel-cpa" aria-label="CPA 连接配置">
      <div className="card-head">
        <div>
          <p className="eyebrow">CPA</p>
          <h2>连接配置</h2>
        </div>
        <button className="button button-secondary" type="button" onClick={resetDraft}>
          <Plus size={16} aria-hidden="true" />
          <span>新增</span>
        </button>
      </div>

      <div className="target-editor-layout">
        <div className="target-list-panel">
          <div className="settings-mini-head">
            <span>已配置 CPA</span>
            <strong>{targets.length}</strong>
          </div>
          <div className="target-list">
            {targets.length === 0 ? (
              <div className="target-empty">还没有 CPA 配置</div>
            ) : (
              targets.map((target) => (
                <button
                  className={`target-row ${editingId === target.id ? 'target-row-active' : ''}`}
                  key={target.id}
                  type="button"
                  onClick={() => editTarget(target)}
                >
                  <span>
                    <strong>{target.name}</strong>
                    <em>{target.apiBase}</em>
                  </span>
                  <StatusPill tone={target.enabled ? 'ok' : 'muted'} label={target.enabled ? '启用' : '停用'} />
                </button>
              ))
            )}
          </div>
        </div>

        <form className="alert-form target-form" onSubmit={handleSave}>
          <div className="settings-mini-head">
            <span>{editingId ? '编辑连接' : '新增连接'}</span>
            <strong>{draft.enabled ? '启用' : '停用'}</strong>
          </div>
          <div className="form-grid">
            <label className="form-field">
              <span>CPA 名称</span>
              <input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} placeholder="Main CPA" />
            </label>
            <label className="form-field">
              <span>状态</span>
              <select value={draft.enabled ? 'enabled' : 'disabled'} onChange={(event) => updateDraft('enabled', event.target.value === 'enabled')}>
                <option value="enabled">启用</option>
                <option value="disabled">停用</option>
              </select>
            </label>
            <label className="form-field field-wide">
              <span>CPA API Base</span>
              <input value={draft.apiBase} onChange={(event) => updateDraft('apiBase', event.target.value)} placeholder="http://127.0.0.1:8398" />
            </label>
            <label className="form-field field-wide">
              <span>Management Key</span>
              <input
                value={draft.managementKey ?? ''}
                onChange={(event) => updateDraft('managementKey', event.target.value)}
                placeholder={editingTarget?.hasManagementKey ? '已保存，留空不变' : '输入 CPA management key'}
                type="password"
                autoComplete="new-password"
              />
            </label>
          </div>

          {error ? (
            <div className="inline-alert" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}

          {success ? (
            <div className="inline-success" role="status">
              <CheckCircle2 size={16} aria-hidden="true" />
              <span>{success}</span>
            </div>
          ) : null}

          <div className="form-actions form-actions-split">
            <div>
              {editingId ? (
                <button className="button button-danger" type="button" onClick={() => void handleDelete()} disabled={busy !== null}>
                  {busy === 'delete' ? <RefreshCw size={16} className="spin" aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
                  <span>删除</span>
                </button>
              ) : null}
            </div>
            <div className="form-actions-inner">
              <button className="button button-secondary" type="button" onClick={() => void handleTest()} disabled={busy !== null}>
                {busy === 'test' ? <RefreshCw size={16} className="spin" aria-hidden="true" /> : <Wifi size={16} aria-hidden="true" />}
                <span>测试连接</span>
              </button>
              <button className="button button-primary" type="submit" disabled={busy !== null}>
                {busy === 'save' ? <RefreshCw size={16} className="spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
                <span>{editingId ? '保存修改' : '添加 CPA'}</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}

function clampCollectMinutes(value: number): number {
  if (!Number.isFinite(value)) return 5;
  return Math.min(60, Math.max(1, Math.round(value)));
}

function clampCollectConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(10, Math.max(1, Math.round(value)));
}

function clampUsageRequestsPerMinute(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.min(60, Math.max(1, Math.round(value)));
}

function collectorSecondsToMinutes(settings: CollectorSettings | null): number {
  return clampCollectMinutes((settings?.collectUsageTickSeconds ?? DEFAULT_COLLECTOR_SETTINGS.collectUsageTickSeconds) / 60);
}

function CollectorSettingsPanel({
  settings,
  onSaved,
}: {
  settings: CollectorSettings | null;
  onSaved: (settings: CollectorSettings) => void;
}) {
  const [draft, setDraft] = useState<{
    autoCollectEnabled?: boolean;
    collectMinutes?: number;
    collectConcurrency?: number;
    collectManualConcurrency?: number;
    requestsPerMinute?: number;
  }>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const autoCollectEnabled = draft.autoCollectEnabled ?? settings?.autoCollectEnabled ?? DEFAULT_COLLECTOR_SETTINGS.autoCollectEnabled;
  const collectMinutes = draft.collectMinutes ?? collectorSecondsToMinutes(settings);
  const collectConcurrency = draft.collectConcurrency ?? settings?.collectConcurrency ?? DEFAULT_COLLECTOR_SETTINGS.collectConcurrency;
  const collectManualConcurrency = draft.collectManualConcurrency ?? settings?.collectManualConcurrency ?? DEFAULT_COLLECTOR_SETTINGS.collectManualConcurrency;
  const requestsPerMinute = draft.requestsPerMinute ?? settings?.collectUsageMaxRequestsPerMinute ?? DEFAULT_COLLECTOR_SETTINGS.collectUsageMaxRequestsPerMinute;

  const buildPayload = (): SaveCollectorSettings => ({
    autoCollectEnabled,
    collectUsageTickMinutes: clampCollectMinutes(collectMinutes),
    collectConcurrency: clampCollectConcurrency(collectConcurrency),
    collectManualConcurrency: clampCollectConcurrency(collectManualConcurrency),
    collectUsageMaxRequestsPerMinute: clampUsageRequestsPerMinute(requestsPerMinute),
  });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await monitorApi.saveCollectorSettings(buildPayload());
      onSaved(saved);
      setDraft({});
      setNotice('采集设置已保存');
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存采集设置失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-block settings-panel settings-panel-collector" aria-label="采集与刷新设置">
      <div className="card-head">
        <div>
          <p className="eyebrow">Collector</p>
          <h2>采集与刷新</h2>
        </div>
        <StatusPill tone={autoCollectEnabled ? 'ok' : 'muted'} label={autoCollectEnabled ? '自动' : '已暂停'} />
      </div>

      <form className="alert-form collector-form" onSubmit={handleSubmit}>
        <div className="collector-layout">
          <label className="toggle-line collector-toggle">
            <input
              type="checkbox"
              checked={autoCollectEnabled}
              onChange={(event) => setDraft((current) => ({ ...current, autoCollectEnabled: event.target.checked }))}
            />
            <span className="switch-track">
              {autoCollectEnabled ? <Play size={13} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
            </span>
            <span>后台自动采集</span>
          </label>

          <div className="form-grid">
            <label className="form-field">
              <span>自动采集间隔（分钟）</span>
              <input
                type="number"
                min={1}
                max={60}
                value={collectMinutes}
                onChange={(event) => setDraft((current) => ({ ...current, collectMinutes: clampCollectMinutes(Number(event.target.value)) }))}
              />
            </label>

            <label className="form-field">
              <span>后台并发</span>
              <input
                type="number"
                min={1}
                max={10}
                value={collectConcurrency}
                onChange={(event) => setDraft((current) => ({ ...current, collectConcurrency: clampCollectConcurrency(Number(event.target.value)) }))}
              />
            </label>

            <label className="form-field">
              <span>手动并发</span>
              <input
                type="number"
                min={1}
                max={10}
                value={collectManualConcurrency}
                onChange={(event) => setDraft((current) => ({ ...current, collectManualConcurrency: clampCollectConcurrency(Number(event.target.value)) }))}
              />
            </label>

            <label className="form-field">
              <span>总限速（次/分钟）</span>
              <input
                type="number"
                min={1}
                max={60}
                value={requestsPerMinute}
                onChange={(event) => setDraft((current) => ({ ...current, requestsPerMinute: clampUsageRequestsPerMinute(Number(event.target.value)) }))}
              />
            </label>

            <div className="readonly-setting field-wide">
              <span>页面刷新</span>
              <strong>固定 30 秒</strong>
              <em>只刷新本地界面，不触发采集</em>
            </div>
          </div>
        </div>

        <p className="settings-note">
          并发表示同时处理的采集任务数；总限速是整个客户端每分钟 Usage 请求预算。上一轮未结束时不会并发启动下一轮，手动立即采集仍可使用。
        </p>

        {error ? (
          <div className="inline-alert" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        {notice ? (
          <div className="inline-success" role="status">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>{notice}</span>
          </div>
        ) : null}

        <div className="form-actions">
          <button className="button button-primary" type="submit" disabled={saving}>
            {saving ? <RefreshCw size={16} className="spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
            <span>{saving ? '保存中' : '保存采集设置'}</span>
          </button>
        </div>
      </form>
    </section>
  );
}

function AlertSettingsPanel({ onSaved }: { onSaved: (settings: EmailAlertSettings) => void }) {
  const [settings, setSettings] = useState<EmailAlertSettings>(DEFAULT_EMAIL_SETTINGS);
  const [smtpPassword, setSmtpPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    monitorApi
      .alertSettings()
      .then((payload) => {
        if (!mounted) return;
        const normalized = { ...DEFAULT_EMAIL_SETTINGS, ...payload };
        setSettings(normalized);
        onSaved(normalized);
      })
      .catch((loadError) => {
        if (mounted) setError(loadError instanceof Error ? loadError.message : '加载邮箱配置失败');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [onSaved]);

  const updateSetting = <Key extends keyof EmailAlertSettings>(key: Key, value: EmailAlertSettings[Key]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setNotice(null);
  };

  const buildPayload = (): SaveEmailAlertSettings => ({
    ...settings,
    smtpPassword: smtpPassword.trim() ? smtpPassword : undefined,
  });

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await monitorApi.saveAlertSettings(buildPayload());
      setSettings(saved);
      onSaved(saved);
      setSmtpPassword('');
      setNotice('邮箱告警配置已保存');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存邮箱配置失败');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError(null);
    setNotice(null);
    try {
      await monitorApi.sendTestEmail(buildPayload());
      setSmtpPassword('');
      setNotice('测试邮件已发送');
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : '测试邮件发送失败');
    } finally {
      setTesting(false);
    }
  };

  return (
      <section className="settings-block settings-panel settings-panel-alert" aria-label="邮箱预警配置">
        <div className="card-head">
          <div>
            <p className="eyebrow">Email Alert</p>
            <h2>邮箱预警</h2>
          </div>
          <StatusPill tone={settings.enabled ? 'ok' : 'muted'} label={settings.enabled ? '开启' : '关闭'} />
        </div>

        {error ? (
          <div className="inline-alert" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
        {notice ? (
          <div className="inline-success" role="status">
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>{notice}</span>
          </div>
        ) : null}

        <form className="alert-form" onSubmit={handleSave}>
          <fieldset disabled={loading || saving || testing}>
            <div className="settings-form-band">
              <div className="settings-mini-head">
                <span>告警规则</span>
                <strong>{settings.enabled ? '开启' : '关闭'}</strong>
              </div>
              <label className="toggle-line alert-toggle">
                <input type="checkbox" checked={settings.enabled} onChange={(event) => updateSetting('enabled', event.target.checked)} />
                <span className="switch-track">{settings.enabled ? <Play size={13} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}</span>
                <span>启用邮箱预警</span>
              </label>

              <label className="form-field field-wide">
                <span>收件邮箱</span>
                <input
                  value={settings.recipients.join(',')}
                  onChange={(event) => updateSetting('recipients', parseRecipientInput(event.target.value))}
                  placeholder="ops@example.com,admin@example.com"
                />
              </label>

              <div className="form-grid">
                <label className="form-field">
                  <span>最低级别</span>
                  <select
                    value={settings.minTone}
                    onChange={(event) => updateSetting('minTone', event.target.value as EmailAlertSettings['minTone'])}
                  >
                    <option value="watch">观察及以上</option>
                    <option value="warn">警告及以上</option>
                    <option value="critical">严重</option>
                  </select>
                </label>

                <label className="form-field">
                  <span>冷却分钟</span>
                  <input
                    type="number"
                    min={1}
                    value={settings.cooldownMinutes}
                    onChange={(event) => updateSetting('cooldownMinutes', Math.max(1, Number(event.target.value) || 1))}
                  />
                </label>

                <label className="form-field">
                  <span>软异常冷却</span>
                  <input
                    type="number"
                    min={1}
                    value={settings.softIssueCooldownMinutes}
                    onChange={(event) => updateSetting('softIssueCooldownMinutes', Math.max(1, Number(event.target.value) || 720))}
                  />
                </label>

                <label className="form-field">
                  <span>异常阈值</span>
                  <input
                    type="number"
                    min={1}
                    value={settings.accountIssueThreshold}
                    onChange={(event) => updateSetting('accountIssueThreshold', Math.max(1, Number(event.target.value) || 1))}
                  />
                </label>

                <label className="form-field">
                  <span>超时秒数</span>
                  <input
                    type="number"
                    min={1}
                    value={settings.timeoutSeconds}
                    onChange={(event) => updateSetting('timeoutSeconds', Math.max(1, Number(event.target.value) || 1))}
                  />
                </label>
              </div>
            </div>

            <div className="settings-form-band">
              <div className="settings-mini-head">
                <span>SMTP</span>
                <strong>{settings.hasSmtpPassword ? '已保存密码' : '未保存密码'}</strong>
              </div>
              <label className="form-field field-wide">
                <span>SMTP Host</span>
                <input value={settings.smtpHost} onChange={(event) => updateSetting('smtpHost', event.target.value)} placeholder="smtp.example.com" />
              </label>

              <div className="form-grid smtp-grid">
                <label className="form-field">
                  <span>SMTP Port</span>
                  <input
                    type="number"
                    min={1}
                    value={settings.smtpPort}
                    onChange={(event) => updateSetting('smtpPort', Math.max(1, Number(event.target.value) || 465))}
                  />
                </label>

                <label className="toggle-line smtp-toggle">
                  <input type="checkbox" checked={settings.smtpSecure} onChange={(event) => updateSetting('smtpSecure', event.target.checked)} />
                  <span className="switch-track">
                    {settings.smtpSecure ? <ShieldCheck size={13} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
                  </span>
                  <span>TLS</span>
                </label>
              </div>

              <label className="form-field field-wide">
                <span>SMTP Username</span>
                <input value={settings.smtpUsername} onChange={(event) => updateSetting('smtpUsername', event.target.value)} placeholder="monitor@example.com" />
              </label>

              <label className="form-field field-wide">
                <span>SMTP Password</span>
                <input
                  value={smtpPassword}
                  onChange={(event) => setSmtpPassword(event.target.value)}
                  placeholder={settings.hasSmtpPassword ? '已保存，留空不变' : '输入密码'}
                  type="password"
                  autoComplete="new-password"
                />
              </label>

              <label className="form-field field-wide">
                <span>From</span>
                <input value={settings.smtpFrom} onChange={(event) => updateSetting('smtpFrom', event.target.value)} placeholder="NeoQuota Monitor <monitor@example.com>" />
              </label>
            </div>
          </fieldset>

          <div className="form-actions">
            <button className="button button-secondary" type="button" onClick={() => void handleTest()} disabled={loading || testing || saving}>
              {testing ? <RefreshCw size={16} className="spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
              <span>{testing ? '发送中' : '测试邮件'}</span>
            </button>
            <button className="button button-primary" type="submit" disabled={loading || saving || testing}>
              {saving ? <RefreshCw size={16} className="spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
              <span>{saving ? '保存中' : '保存'}</span>
            </button>
          </div>
        </form>
      </section>
  );
}

function isCustomizedPricingProfile(profile: PricingProfile): boolean {
  return profile.updatedAt > 0 || profile.id !== DEFAULT_PRICING_PROFILE.id;
}

function pricingValueLabel(value: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? formatUsd(value) : '未计价';
}

function countUnpricedPricingWindows(profile: PricingProfile): number {
  return PLAN_ORDER.reduce((total, plan) => {
    const values = profile.plans[plan];
    return total + (values.fiveHourUsd === null ? 1 : 0) + (values.weeklyUsd === null ? 1 : 0);
  }, 0);
}

function parsePricingValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed);
}

function PricingSettingsPanel({
  profile,
  onSaved,
}: {
  profile: PricingProfile;
  onSaved: (profile: PricingProfile) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<PricingProfile>(() => normalizePricingProfile(profile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const updateMeta = <Key extends 'name' | 'sourceLabel'>(key: Key, value: PricingProfile[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice(null);
  };

  const updatePlan = (plan: Exclude<PlanKey, 'unknown'>, key: 'fiveHourUsd' | 'weeklyUsd', value: string) => {
    setDraft((current) => ({
      ...current,
      id: current.id === DEFAULT_PRICING_PROFILE.id ? 'custom-local-pricing' : current.id,
      name: current.name === DEFAULT_PRICING_PROFILE.name ? '自定义额度换算' : current.name,
      sourceLabel: current.sourceLabel === DEFAULT_PRICING_PROFILE.sourceLabel ? '后台自定义折算，非官方账单金额' : current.sourceLabel,
      plans: {
        ...current.plans,
        [plan]: {
          ...current.plans[plan],
          [key]: parsePricingValue(value),
        },
      },
    }));
    setNotice(null);
  };

  const resetToReference = () => {
    setDraft(normalizePricingProfile(DEFAULT_PRICING_PROFILE));
    setNotice(null);
    setError(null);
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload = normalizePricingProfile({
        ...draft,
        id: draft.id.trim() || 'custom-local-pricing',
        name: draft.name.trim() || '自定义额度换算',
        sourceLabel: draft.sourceLabel.trim() || '后台自定义折算，非官方账单金额',
      });
      const saved = await monitorApi.savePricing(payload);
      setDraft(saved);
      await onSaved(saved);
      setNotice('额度换算已保存，当前数据已重新估算');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存额度换算失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-block settings-panel settings-panel-pricing" aria-label="额度换算配置">
      <div className="card-head">
        <div>
          <p className="eyebrow">Quota Pricing</p>
          <h2>额度换算</h2>
        </div>
        <StatusPill tone={isCustomizedPricingProfile(draft) ? 'ok' : 'muted'} label={isCustomizedPricingProfile(draft) ? '自定义' : '参考值'} />
      </div>

      {error ? (
        <div className="inline-alert" role="alert">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}
      {notice ? (
        <div className="inline-success" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />
          <span>{notice}</span>
        </div>
      ) : null}

      <form className="alert-form pricing-form" onSubmit={handleSave}>
        <fieldset disabled={saving}>
          <div className="settings-form-band">
            <div className="settings-mini-head">
              <span>配置</span>
              <strong>{draft.updatedAt > 0 ? formatDateTime(draft.updatedAt) : '参考默认'}</strong>
            </div>
            <div className="form-grid">
              <label className="form-field">
                <span>名称</span>
                <input value={draft.name} onChange={(event) => updateMeta('name', event.target.value)} placeholder="自定义额度换算" />
              </label>
              <label className="form-field field-wide">
                <span>说明</span>
                <input
                  value={draft.sourceLabel}
                  onChange={(event) => updateMeta('sourceLabel', event.target.value)}
                  placeholder="后台自定义折算，非官方账单金额"
                />
              </label>
            </div>
          </div>

          <div className="settings-form-band">
            <div className="settings-mini-head">
              <span>套餐窗口</span>
              <strong>{countUnpricedPricingWindows(draft)} 个未计价</strong>
            </div>
            <div className="pricing-editor-grid">
              {PLAN_ORDER.map((plan) => (
                <div className="pricing-editor-row" key={plan}>
                  <strong>{getPlanLabel(plan)}</strong>
                  <label>
                    <span>5h 满额 $</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      value={draft.plans[plan].fiveHourUsd ?? ''}
                      onChange={(event) => updatePlan(plan, 'fiveHourUsd', event.target.value)}
                      placeholder="未计价"
                    />
                  </label>
                  <label>
                    <span>周限满额 $</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      value={draft.plans[plan].weeklyUsd ?? ''}
                      onChange={(event) => updatePlan(plan, 'weeklyUsd', event.target.value)}
                      placeholder="未计价"
                    />
                  </label>
                </div>
              ))}
            </div>
          </div>
        </fieldset>

        <p className="settings-note">
          这里配置的是内部容量换算表：usage 返回的剩余点数会按对应套餐和窗口满额折算，留空表示该套餐窗口不参与金额估算。
        </p>

        <div className="form-actions">
          <button className="button button-secondary" type="button" onClick={resetToReference} disabled={saving}>
            <Calculator size={16} aria-hidden="true" />
            <span>恢复参考值</span>
          </button>
          <button className="button button-primary" type="submit" disabled={saving}>
            {saving ? <RefreshCw size={16} className="spin" aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}
            <span>{saving ? '保存中' : '保存额度换算'}</span>
          </button>
        </div>
      </form>
    </section>
  );
}

function SettingsModal({
  eyebrow,
  title,
  onClose,
  children,
}: {
  eyebrow: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="settings-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section className="settings-modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="settings-modal-head">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2>{title}</h2>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="settings-modal-body">{children}</div>
      </section>
    </div>
  );
}

function SettingsModule({
  targets,
  onTargetsChanged,
  onAlertSaved,
  onCollectorSaved,
  onPricingSaved,
  alertSettings,
  collectorSettings,
  pricingProfile,
}: {
  targets: CpaTargetConfig[];
  onTargetsChanged: () => Promise<void>;
  onAlertSaved: (settings: EmailAlertSettings) => void;
  onCollectorSaved: (settings: CollectorSettings) => void;
  onPricingSaved: (profile: PricingProfile) => Promise<void> | void;
  alertSettings: EmailAlertSettings | null;
  collectorSettings: CollectorSettings | null;
  pricingProfile: PricingProfile;
}) {
  const [activeDialog, setActiveDialog] = useState<SettingsDialog>(null);
  const [cpaDialogMode, setCpaDialogMode] = useState<CpaDialogMode>('manage');
  const [cpaDialogTargetId, setCpaDialogTargetId] = useState<string | null>(null);
  const collectMinutes = collectorSecondsToMinutes(collectorSettings);
  const autoCollectEnabled = collectorSettings?.autoCollectEnabled ?? true;
  const collectConcurrency = collectorSettings?.collectConcurrency ?? DEFAULT_COLLECTOR_SETTINGS.collectConcurrency;
  const manualConcurrency = collectorSettings?.collectManualConcurrency ?? DEFAULT_COLLECTOR_SETTINGS.collectManualConcurrency;
  const requestsPerMinute = collectorSettings?.collectUsageMaxRequestsPerMinute ?? DEFAULT_COLLECTOR_SETTINGS.collectUsageMaxRequestsPerMinute;
  const enabledTargets = targets.filter((target) => target.enabled).length;
  const previewTargets = targets.slice(0, 3);
  const emailIssues = getEmailConfigIssues(alertSettings);
  const emailReady = alertSettings !== null && emailIssues.length === 0;
  const emailStatusTone = alertSettings === null ? 'muted' : emailReady ? 'ok' : 'watch';
  const emailStatusLabel = alertSettings === null ? '加载中' : emailReady ? '就绪' : '待配置';
  const cpaStatusLabel = targets.length === 0 ? '未配置' : `${enabledTargets}/${targets.length} 启用`;
  const pricingCustomized = isCustomizedPricingProfile(pricingProfile);
  const pricingUnpricedWindows = countUnpricedPricingWindows(pricingProfile);
  const configuredModuleCount = (enabledTargets > 0 ? 1 : 0) + (collectorSettings !== null ? 1 : 0) + (pricingCustomized ? 1 : 0) + (emailReady ? 1 : 0);
  const openCpaDialog = (mode: CpaDialogMode, targetId: string | null = null) => {
    setCpaDialogMode(mode);
    setCpaDialogTargetId(targetId);
    setActiveDialog('cpa');
  };
  const dialogMeta =
    activeDialog === 'cpa'
      ? { eyebrow: 'CPA', title: cpaDialogMode === 'create' ? '新增 CPA' : '管理 CPA' }
      : activeDialog === 'collector'
        ? { eyebrow: 'Collector', title: '采集与刷新' }
        : activeDialog === 'pricing'
          ? { eyebrow: 'Quota Pricing', title: '额度换算' }
        : activeDialog === 'alert'
          ? { eyebrow: 'Email Alert', title: '邮箱预警' }
          : null;

  return (
    <div className="settings-module">
      <header className="settings-heading">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>配置总览</h2>
        </div>
        <StatusPill tone={configuredModuleCount === 4 ? 'ok' : 'watch'} label={`${configuredModuleCount}/4 模块已配置`} />
      </header>

      <div className="settings-sections">
        <section className="content-card settings-config-section" aria-label="CPA 配置">
          <div className="card-head settings-section-head">
            <div>
              <p className="eyebrow">CPA</p>
              <h2>连接配置</h2>
            </div>
            <div className="settings-section-head-actions">
              <StatusPill tone={enabledTargets > 0 ? 'ok' : 'watch'} label={cpaStatusLabel} />
              <button className="button button-secondary" type="button" onClick={() => openCpaDialog('create')}>
                <Plus size={16} aria-hidden="true" />
                <span>新增 CPA</span>
              </button>
              <button className="button button-secondary" type="button" onClick={() => openCpaDialog('manage')}>
                <Settings size={16} aria-hidden="true" />
                <span>管理 CPA</span>
              </button>
            </div>
          </div>

          <div className="settings-section-body">
            <div className="settings-section-primary">
              <strong>{enabledTargets} / {targets.length}</strong>
              <span>启用 / 全部 CPA</span>
            </div>

            <div className={`settings-preview-list ${previewTargets.length <= 1 ? 'settings-preview-list-single' : ''}`}>
              {previewTargets.length === 0 ? (
                <div className="settings-preview-empty">还没有 CPA 配置</div>
              ) : (
                previewTargets.map((target) => (
                  <button className="settings-preview-row settings-preview-row-button" key={target.id} type="button" onClick={() => openCpaDialog('manage', target.id)}>
                    <span>
                      <strong>{target.name}</strong>
                      <em>{target.apiBase}</em>
                    </span>
                    <StatusPill tone={target.enabled ? 'ok' : 'muted'} label={target.enabled ? '启用' : '停用'} />
                  </button>
                ))
              )}
              {targets.length > previewTargets.length ? <div className="settings-preview-more">还有 {targets.length - previewTargets.length} 个 CPA</div> : null}
            </div>
          </div>
        </section>

        <section className="content-card settings-config-section" aria-label="采集配置">
          <div className="card-head settings-section-head">
            <div>
              <p className="eyebrow">Collector</p>
              <h2>采集与刷新</h2>
            </div>
            <div className="settings-section-head-actions">
              <StatusPill tone={autoCollectEnabled ? 'ok' : 'muted'} label={autoCollectEnabled ? '自动' : '暂停'} />
              <button className="button button-secondary" type="button" onClick={() => setActiveDialog('collector')}>
                <Settings size={16} aria-hidden="true" />
                <span>编辑采集设置</span>
              </button>
            </div>
          </div>

          <div className="settings-section-body">
            <div className="settings-section-primary">
              <strong>{autoCollectEnabled ? `${collectMinutes} 分钟` : '已暂停'}</strong>
              <span>后台自动采集间隔</span>
            </div>

            <div className="settings-preview-list settings-preview-metrics">
              <div className="settings-preview-row">
                <span>
                  <strong>{collectConcurrency} / {manualConcurrency}</strong>
                  <em>后台 / 手动并发</em>
                </span>
              </div>
              <div className="settings-preview-row">
                <span>
                  <strong>{requestsPerMinute} 次/分钟</strong>
                  <em>Usage 请求预算</em>
                </span>
              </div>
              <div className="settings-preview-row">
                <span>
                  <strong>30 秒</strong>
                  <em>本地界面固定刷新</em>
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="content-card settings-config-section" aria-label="额度换算配置">
          <div className="card-head settings-section-head">
            <div>
              <p className="eyebrow">Quota Pricing</p>
              <h2>额度换算</h2>
            </div>
            <div className="settings-section-head-actions">
              <StatusPill tone={pricingCustomized ? 'ok' : 'muted'} label={pricingCustomized ? '自定义' : '参考值'} />
              <button className="button button-secondary" type="button" onClick={() => setActiveDialog('pricing')}>
                <Settings size={16} aria-hidden="true" />
                <span>编辑额度换算</span>
              </button>
            </div>
          </div>

          <div className="settings-section-body">
            <div className="settings-section-primary">
              <strong>{pricingProfile.name}</strong>
              <span>{pricingProfile.sourceLabel}</span>
            </div>

            <div className="settings-preview-list settings-preview-metrics pricing-preview-metrics">
              <div className="settings-preview-row">
                <span>
                  <strong>{pricingValueLabel(pricingProfile.plans.plus.fiveHourUsd)} / {pricingValueLabel(pricingProfile.plans.plus.weeklyUsd)}</strong>
                  <em>Plus 5h / 周限</em>
                </span>
              </div>
              <div className="settings-preview-row">
                <span>
                  <strong>{pricingValueLabel(pricingProfile.plans.team.fiveHourUsd)} / {pricingValueLabel(pricingProfile.plans.team.weeklyUsd)}</strong>
                  <em>Team 5h / 周限</em>
                </span>
              </div>
              <div className="settings-preview-row">
                <span>
                  <strong>{pricingUnpricedWindows} 个</strong>
                  <em>未计价窗口</em>
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="content-card settings-config-section" aria-label="邮箱预警配置">
          <div className="card-head settings-section-head">
            <div>
              <p className="eyebrow">Email Alert</p>
              <h2>邮箱预警</h2>
            </div>
            <div className="settings-section-head-actions">
              <StatusPill tone={emailStatusTone} label={emailStatusLabel} />
              <button className="button button-secondary" type="button" onClick={() => setActiveDialog('alert')}>
                <Settings size={16} aria-hidden="true" />
                <span>编辑邮箱预警</span>
              </button>
            </div>
          </div>

          <div className="settings-section-body">
            <div className="settings-section-primary">
              <strong>{alertSettings?.enabled ? '开启' : '关闭'}</strong>
              <span>{alertSettings?.recipients.length ?? 0} 个收件人</span>
            </div>

            <div className="settings-preview-list settings-preview-metrics">
              <div className="settings-preview-row">
                <span>
                  <strong>{getEmailToneLabel(alertSettings?.minTone)}</strong>
                  <em>最低告警级别</em>
                </span>
              </div>
              <div className="settings-preview-row">
                <span>
                  <strong>{alertSettings?.cooldownMinutes ?? 30} 分钟</strong>
                  <em>同一 CPA 同类告警冷却</em>
                </span>
              </div>
              <div className="settings-preview-row">
                <span>
                  <strong>{alertSettings?.hasSmtpPassword ? '已保存' : '未保存'}</strong>
                  <em>SMTP 密码</em>
                </span>
              </div>
              {!emailReady && alertSettings !== null ? <div className="settings-preview-more">{formatEmailIssueSummary(emailIssues)}</div> : null}
            </div>
          </div>
        </section>
      </div>

      {dialogMeta ? (
        <SettingsModal eyebrow={dialogMeta.eyebrow} title={dialogMeta.title} onClose={() => setActiveDialog(null)}>
          {activeDialog === 'cpa' ? (
            <CpaTargetsPanel targets={targets} onChanged={onTargetsChanged} initialMode={cpaDialogMode} initialTargetId={cpaDialogTargetId} />
          ) : null}
          {activeDialog === 'collector' ? <CollectorSettingsPanel settings={collectorSettings} onSaved={onCollectorSaved} /> : null}
          {activeDialog === 'pricing' ? <PricingSettingsPanel profile={pricingProfile} onSaved={onPricingSaved} /> : null}
          {activeDialog === 'alert' ? <AlertSettingsPanel onSaved={onAlertSaved} /> : null}
        </SettingsModal>
      ) : null}
    </div>
  );
}

export function App() {
  const [booting, setBooting] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [targets, setTargets] = useState<CpaTargetConfig[]>([]);
  const [latest, setLatest] = useState<LatestPayload | null>(null);
  const [selectedCpaId, setSelectedCpaId] = useState('');
  const [loading, setLoading] = useState(false);
  const [manualCollectPending, setManualCollectPending] = useState(false);
  const [accountAction, setAccountAction] = useState<AccountActionState>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [activeModule, setActiveModule] = useState<AppModule>('overview');
  const [alertSettings, setAlertSettings] = useState<EmailAlertSettings | null>(null);
  const [collectorSettings, setCollectorSettings] = useState<CollectorSettings | null>(null);
  const [pricingProfile, setPricingProfile] = useState<PricingProfile>(DEFAULT_PRICING_PROFILE);
  const [alertLoading, setAlertLoading] = useState(false);
  const selectedCpaIdRef = useRef('');

  const loadLatest = useCallback(async (cpaId?: string | null) => {
    setLoading(true);
    setPageError(null);
    try {
      const payload = await monitorApi.latest(cpaId ?? undefined);
      setLatest(payload);
      setSelectedCpaId(payload.selectedCpaId);
      setPricingProfile(payload.pricingProfile);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '加载监控数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAppState = useCallback(async (loadData = true) => {
    const state = await monitorApi.appState();
    setConfigured(state.configured);
    setTargets(state.targets);
    setCollectorSettings(state.collector);
    setAlertSettings(state.emailAlert);
    setPricingProfile(state.pricingProfile);
    setAlertLoading(false);
    if (state.configured && loadData) {
      await loadLatest(selectedCpaId || undefined);
    }
    if (!state.configured) {
      setLatest(null);
      setSelectedCpaId('');
    }
  }, [loadLatest, selectedCpaId]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const state = await monitorApi.appState();
        if (!mounted) return;
        setConfigured(state.configured);
        setTargets(state.targets);
        setCollectorSettings(state.collector);
        setAlertSettings(state.emailAlert);
        setPricingProfile(state.pricingProfile);
        setAlertLoading(false);
        if (state.configured) await loadLatest();
      } catch (error) {
        if (mounted) setPageError(error instanceof Error ? error.message : '启动客户端失败');
      } finally {
        if (mounted) setBooting(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [loadLatest]);

  useEffect(() => {
    selectedCpaIdRef.current = selectedCpaId;
  }, [selectedCpaId]);

  useEffect(() => {
    let mounted = true;
    let unlistenLatest: (() => void) | null = null;
    let unlistenCollectorState: (() => void) | null = null;
    let unlistenPaused: (() => void) | null = null;
    void monitorApi.onLatestPayload((payload) => {
      if (!mounted) return;
      const currentSelectedCpaId = selectedCpaIdRef.current;
      if (currentSelectedCpaId && payload.selectedCpaId !== currentSelectedCpaId) return;
      setLatest(payload);
      if (!currentSelectedCpaId) setSelectedCpaId(payload.selectedCpaId);
      setPricingProfile(payload.pricingProfile);
    }).then((unlisten) => {
      unlistenLatest = unlisten;
    });
    void monitorApi.onCollectorState((payload) => {
      if (!mounted) return;
      setLatest((current) => {
        if (!current || current.selectedCpaId !== payload.cpaId) return current;
        return { ...current, collectorState: payload.collectorState };
      });
    }).then((unlisten) => {
      unlistenCollectorState = unlisten;
    });
    void monitorApi.onCollectorPaused((payload) => {
      if (!mounted) return;
      if (payload.collector) {
        setCollectorSettings(payload.collector);
      } else {
        setCollectorSettings((current) => {
          const base = current ?? DEFAULT_COLLECTOR_SETTINGS;
          return { ...base, autoCollectEnabled: !payload.paused };
        });
      }
    }).then((unlisten) => {
      unlistenPaused = unlisten;
    });
    return () => {
      mounted = false;
      unlistenLatest?.();
      unlistenCollectorState?.();
      unlistenPaused?.();
    };
  }, []);

  useEffect(() => {
    if (!configured) return;
    const timer = window.setInterval(() => {
      void loadLatest(selectedCpaId || undefined);
    }, PAGE_AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [configured, loadLatest, selectedCpaId]);

  const showTargetSelect = (latest?.targets.length ?? 0) > 1;
  const collectProgress = getCollectorProgress(latest?.collectorState);
  const collectButtonBusy = manualCollectPending || collectProgress.running;
  const toolbarProgressActive = collectProgress.running || manualCollectPending;
  const selectedTarget = latest?.targets.find((target) => target.id === selectedCpaId);
  const selectedTargetName = selectedTarget?.name ?? selectedCpaId;
  const toolbarStatusLabel = collectProgress.running
    ? collectProgress.label
    : manualCollectPending
      ? '正在启动采集'
      : getCollectorStatusLabel(latest?.collectorState.status ?? 'idle');
  const toolbarStatusDetail = latest?.snapshot
    ? `fresh ${formatInteger(latest.snapshot.collection.freshAccounts)}/${formatInteger(latest.snapshot.collection.enabledAccounts)} · ${latest.capacity.snapshotAgeMs === null ? formatTime(latest.snapshot.capturedAt) : formatAge(latest.capacity.snapshotAgeMs)}`
    : loading
      ? '加载中'
      : '等待数据';
  const emailIssues = useMemo(() => getEmailConfigIssues(alertSettings), [alertSettings]);
  const alertSummary = {
    enabled: Boolean(alertSettings?.enabled),
    recipients: alertSettings?.recipients.length ?? 0,
    ready: alertSettings !== null && emailIssues.length === 0,
    loading: alertLoading || alertSettings === null,
  };
  const handleAlertSaved = useCallback((settings: EmailAlertSettings) => {
    setAlertSettings(settings);
  }, []);

  const handleCollectorSaved = useCallback((settings: CollectorSettings) => {
    setCollectorSettings(settings);
  }, []);

  const handlePricingSaved = useCallback(async (profile: PricingProfile) => {
    setPricingProfile(profile);
    await loadLatest(selectedCpaId || undefined);
  }, [loadLatest, selectedCpaId]);

  const handleTargetsChanged = useCallback(async () => {
    await loadAppState(true);
  }, [loadAppState]);

  const handleConfigured = useCallback(async () => {
    await loadAppState(true);
  }, [loadAppState]);

  const applyLatestPayload = useCallback((payload: LatestPayload) => {
    setLatest(payload);
    setSelectedCpaId(payload.selectedCpaId);
    setPricingProfile(payload.pricingProfile);
  }, []);

  const handleSmartCollect = async () => {
    if (!selectedCpaId) return;
    setManualCollectPending(true);
    setPageError(null);
    try {
      const payload = await monitorApi.refresh(selectedCpaId, { coverageMode: 'full-rate-limited' });
      applyLatestPayload(payload);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '启动采集失败');
    } finally {
      setManualCollectPending(false);
    }
  };

  const handleAccountRefresh = async (row: AccountQuotaRow) => {
    const rowActionKey = getAccountRowKey(row);
    setAccountAction({ key: rowActionKey, action: 'refresh' });
    setPageError(null);
    try {
      const payload = await monitorApi.refreshAccount(row.cpaId, row.accountKey);
      applyLatestPayload(payload);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '刷新账号失败');
    } finally {
      setAccountAction((current) => (current?.key === rowActionKey ? null : current));
    }
  };

  const handleAccountToggle = async (row: AccountQuotaRow, enabled: boolean) => {
    const authFileName = getAccountAuthFileName(row);
    const rowActionKey = getAccountRowKey(row);
    setAccountAction({ key: rowActionKey, action: 'toggle' });
    setPageError(null);
    try {
      const payload = await monitorApi.setAccountDisabled(row.cpaId, authFileName, !enabled);
      applyLatestPayload(payload);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '修改凭证状态失败');
    } finally {
      setAccountAction((current) => (current?.key === rowActionKey ? null : current));
    }
  };

  const handleAccountDelete = async (row: AccountQuotaRow) => {
    const authFileName = getAccountAuthFileName(row);
    if (!window.confirm(`确定删除凭证 ${authFileName} 吗？此操作会从 CPA 中移除该认证文件。`)) {
      return;
    }
    const rowActionKey = getAccountRowKey(row);
    setAccountAction({ key: rowActionKey, action: 'delete' });
    setPageError(null);
    try {
      const payload = await monitorApi.deleteAccountCredential(row.cpaId, authFileName);
      applyLatestPayload(payload);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : '删除凭证失败');
    } finally {
      setAccountAction((current) => (current?.key === rowActionKey ? null : current));
    }
  };

  if (booting) {
    return (
      <main className="login-shell">
        <div className="login-panel loading-panel">
          <RefreshCw size={24} className="spin" aria-hidden="true" />
          <strong>正在启动本地客户端</strong>
        </div>
      </main>
    );
  }

  if (!configured) {
    return <TargetSetupPanel onConfigured={handleConfigured} />;
  }

  return (
    <main className="monitor-shell">
      <div className="app-layout">
        <aside className="app-sidebar">
          <nav className="module-nav" aria-label="模块">
            {MODULES.map((module) => (
              <button
                key={module.id}
                className={`module-nav-item ${activeModule === module.id ? 'module-nav-item-active' : ''}`}
                type="button"
                onClick={() => setActiveModule(module.id)}
              >
                {module.icon}
                <span>{module.label}</span>
              </button>
            ))}
          </nav>

        </aside>

        <section className="app-main">
          <header className="app-toolbar">
            <div className="toolbar-cpa">
              <span>当前 CPA</span>
              {showTargetSelect ? (
                <label className="target-select" title="选择 CPA">
                  <span className="sr-only">CPA</span>
                  <select value={selectedCpaId} onChange={(event) => void loadLatest(event.target.value)} disabled={loading}>
                    {(latest?.targets ?? []).map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <strong>{selectedTargetName || '未选择'}</strong>
              )}
            </div>

            <div className={`toolbar-collector ${toolbarProgressActive ? 'toolbar-collector-active' : ''}`} role="status" aria-live="polite">
              <div className="toolbar-collector-copy">
                <span>{toolbarStatusLabel}</span>
                <em>{toolbarStatusDetail}</em>
              </div>
              <div className="collect-progress-track" aria-hidden="true">
                <i
                  className={collectProgress.percent === null && toolbarProgressActive ? 'collect-progress-bar collect-progress-bar-pending' : 'collect-progress-bar'}
                  style={collectProgress.percent === null ? { width: toolbarProgressActive ? undefined : '0%' } : { width: `${collectProgress.percent}%` }}
                />
              </div>
            </div>

            <div className="toolbar-actions">
              <button className="button button-primary" type="button" onClick={() => void handleSmartCollect()} disabled={collectButtonBusy || !selectedCpaId}>
                <RefreshCw size={16} className={collectButtonBusy ? 'spin' : undefined} aria-hidden="true" />
                <span>{collectProgress.running ? '采集中' : manualCollectPending ? '启动中' : '立即采集'}</span>
              </button>
            </div>
          </header>

          {pageError ? (
            <div className="page-alert" role="alert">
              <AlertTriangle size={18} aria-hidden="true" />
              <span>{pageError}</span>
            </div>
          ) : null}

          <div className="module-content">
            {latest ? (
              <>
                {activeModule === 'overview' ? (
                  <OverviewModule
                    latest={latest}
                    alertSummary={alertSummary}
                    emailIssues={emailIssues}
                    onOpenSettings={() => setActiveModule('settings')}
                  />
                ) : null}
                {activeModule === 'accounts' ? (
                  <AccountDetailsModule
                    accounts={latest.accounts}
                    accountAction={accountAction}
                    refreshDisabled={collectButtonBusy}
                    onRefreshAccount={handleAccountRefresh}
                    onToggleAccount={handleAccountToggle}
                    onDeleteAccount={handleAccountDelete}
                  />
                ) : null}
                {activeModule === 'settings' ? (
                  <SettingsModule
                    targets={targets}
                    onTargetsChanged={handleTargetsChanged}
                    onAlertSaved={handleAlertSaved}
                    onCollectorSaved={handleCollectorSaved}
                    onPricingSaved={handlePricingSaved}
                    alertSettings={alertSettings}
                    collectorSettings={collectorSettings}
                    pricingProfile={pricingProfile}
                  />
                ) : null}
              </>
            ) : (
              <section className="content-card empty-monitor">
                <RefreshCw size={22} className={loading ? 'spin' : undefined} aria-hidden="true" />
                <strong>{loading ? '正在加载数据' : '暂无监控数据'}</strong>
              </section>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;
