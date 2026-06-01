import type {
  AccountConsumptionSummary,
  AccountQuotaRow,
  ConsumptionSummary,
  MonitorStats,
  PredictionSummary,
  RefreshBucket,
  RiskOptions,
  RiskSummary,
  WindowId,
} from './domain';

const RESET_MATCH_TOLERANCE_MS = 2 * 60 * 1000;
const ZERO_CONSUMPTION_MIN_COVERAGE_PERCENT = 60;
const MAX_BOUNDARY_BASELINE_MS = 90 * 60 * 1000;

type HistoricalWindowSample = {
  cpaId: string;
  accountKey: string;
  name: string;
  normalizedPlan: string;
  capturedAt: number;
  usedPercent: number | null;
  resetAtMs: number | null;
  consumedUsdPerPoint: number | null;
};

function isCountableQuotaRow(row: AccountQuotaRow): boolean {
  return row.status === 'active' && (row.quotaSource === 'fresh' || row.quotaSource === 'cached');
}

function isTrustedQuotaRow(row: AccountQuotaRow, nowMs: number, trustMaxMs: number): boolean {
  if (!isCountableQuotaRow(row)) return false;
  if (row.quotaSource === 'fresh') return true;
  if (row.quotaSource !== 'cached') return false;
  const sampledAt = row.quotaSampledAt;
  if (typeof sampledAt !== 'number' || !Number.isFinite(sampledAt)) return false;
  return nowMs - sampledAt <= trustMaxMs;
}

function sumWindowUsd(rows: AccountQuotaRow[], key: 'fiveHour' | 'weekly'): number {
  return rows.reduce((sum, row) => {
    const value = row[key]?.remainingUsd;
    return typeof value === 'number' && Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function getWindowFullUsd(row: AccountQuotaRow): number | null {
  const remainingUsd = row.fiveHour?.remainingUsd;
  const remainingPoints = row.fiveHour?.remainingPoints;
  if (
    typeof remainingUsd !== 'number' ||
    typeof remainingPoints !== 'number' ||
    !Number.isFinite(remainingUsd) ||
    !Number.isFinite(remainingPoints) ||
    remainingPoints <= 0
  ) {
    return null;
  }
  return (remainingUsd / remainingPoints) * 100;
}

function getFutureRefreshUsd(row: AccountQuotaRow, nowMs: number, atMs: number): number {
  const resetAtMs = row.fiveHour?.resetAtMs;
  const remainingUsd = row.fiveHour?.remainingUsd;
  const fullUsd = getWindowFullUsd(row);
  if (
    typeof resetAtMs !== 'number' ||
    typeof remainingUsd !== 'number' ||
    typeof fullUsd !== 'number' ||
    !Number.isFinite(resetAtMs) ||
    !Number.isFinite(remainingUsd) ||
    !Number.isFinite(fullUsd) ||
    resetAtMs <= nowMs ||
    resetAtMs > atMs
  ) {
    return 0;
  }
  return Math.max(0, fullUsd - remainingUsd);
}

export function buildMonitorStats(rows: AccountQuotaRow[]): MonitorStats {
  const countableRows = rows.filter(isCountableQuotaRow);
  const sumWindow = (key: 'fiveHour' | 'weekly', field: 'remainingPoints' | 'remainingUsd') =>
    countableRows.reduce((sum, row) => {
      const value = row[key]?.[field];
      return typeof value === 'number' && Number.isFinite(value) ? sum + value : sum;
    }, 0);

  return {
    totalAccounts: rows.length,
    enabledAccounts: rows.filter((row) => !row.disabled).length,
    pausedAccounts: rows.filter((row) => row.disabled).length,
    failedOrUnknownAccounts: rows.filter(
      (row) =>
        !row.disabled &&
        (row.status === 'failed' ||
          row.status === 'unknown' ||
          row.quotaSource === 'failed' ||
          row.quotaSource === 'backoff' ||
          row.quotaSource === 'pending'),
    ).length,
    successfulAccounts: countableRows.length,
    fiveHourRemainingPoints: sumWindow('fiveHour', 'remainingPoints'),
    weeklyRemainingPoints: sumWindow('weekly', 'remainingPoints'),
    fiveHourRemainingUsd: sumWindow('fiveHour', 'remainingUsd'),
    weeklyRemainingUsd: sumWindow('weekly', 'remainingUsd'),
    unpricedFiveHourAccounts: countableRows.filter((row) => row.fiveHour && !row.fiveHour.priced).length,
    unpricedWeeklyAccounts: countableRows.filter((row) => row.weekly && !row.weekly.priced).length,
  };
}

function getBucketLabel(resetAtMs: number): { label: string; sortMinute: number } {
  const date = new Date(resetAtMs);
  const hour = date.getHours();
  const minute = Math.floor(date.getMinutes() / 5) * 5;
  return {
    label: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`,
    sortMinute: hour * 60 + minute,
  };
}

function ensureBucket(map: Map<string, RefreshBucket>, label: string, sortMinute: number): RefreshBucket {
  const existing = map.get(label);
  if (existing) return existing;
  const bucket: RefreshBucket = { bucket: label, sortMinute, fiveHourAccounts: [], weeklyAccounts: [] };
  map.set(label, bucket);
  return bucket;
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

export function buildRefreshBuckets(rows: AccountQuotaRow[]): RefreshBucket[] {
  const map = new Map<string, RefreshBucket>();
  rows.filter(isCountableQuotaRow).forEach((row) => {
    if (row.fiveHour?.resetAtMs) {
      const { label, sortMinute } = getBucketLabel(row.fiveHour.resetAtMs);
      pushUnique(ensureBucket(map, label, sortMinute).fiveHourAccounts, row.name);
    }
    if (row.weekly?.resetAtMs) {
      const { label, sortMinute } = getBucketLabel(row.weekly.resetAtMs);
      pushUnique(ensureBucket(map, label, sortMinute).weeklyAccounts, row.name);
    }
  });
  return Array.from(map.values()).sort((left, right) => left.sortMinute - right.sortMinute);
}

function isSameResetCycle(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return true;
  return Math.abs(left - right) <= RESET_MATCH_TOLERANCE_MS;
}

export function calculateConsumptionFromSamples(
  samples: HistoricalWindowSample[],
  minutes: number,
  nowMs: number,
) {
  const cutoff = nowMs - minutes * 60 * 1000;
  const baselineCutoff = cutoff - MAX_BOUNDARY_BASELINE_MS;
  const series = new Map<string, HistoricalWindowSample[]>();

  samples
    .filter((sample) => sample.capturedAt >= baselineCutoff && sample.capturedAt <= nowMs)
    .sort((left, right) => left.capturedAt - right.capturedAt)
    .forEach((sample) => {
      if (sample.usedPercent === null) return;
      const key = `${sample.cpaId}::${sample.accountKey || sample.name}`;
      const entries = series.get(key) ?? [];
      entries.push(sample);
      series.set(key, entries);
    });

  const byAccount = new Map<string, AccountConsumptionSummary>();
  let comparableSeries = 0;
  let unpricedSeries = 0;

  series.forEach((entries, accountKey) => {
    if (entries.length < 2) return;
    let consumedUsd = 0;
    let hasUnpricedDelta = false;
    let hasComparableDelta = false;
    let previous = entries[0];

    for (let index = 1; index < entries.length; index += 1) {
      const current = entries[index];
      const currentInsideWindow = current.capturedAt >= cutoff && current.capturedAt <= nowMs;
      if (
        previous.usedPercent === null ||
        current.usedPercent === null ||
        !isSameResetCycle(previous.resetAtMs, current.resetAtMs) ||
        !currentInsideWindow
      ) {
        previous = current;
        continue;
      }

      hasComparableDelta = true;
      const delta = current.usedPercent - previous.usedPercent;
      if (delta > 0) {
        const usdPerPoint = current.consumedUsdPerPoint ?? previous.consumedUsdPerPoint;
        if (typeof usdPerPoint === 'number' && Number.isFinite(usdPerPoint)) {
          consumedUsd += delta * usdPerPoint;
        } else {
          hasUnpricedDelta = true;
        }
      }
      previous = current;
    }

    if (!hasComparableDelta) return;
    comparableSeries += 1;
    if (hasUnpricedDelta) {
      unpricedSeries += 1;
      byAccount.set(accountKey, { usd: null, state: 'unpriced' });
      return;
    }

    byAccount.set(accountKey, { usd: consumedUsd, state: 'priced' });
  });

  const totalUsd = Array.from(byAccount.values()).reduce((sum, value) => sum + (value.usd ?? 0), 0);
  return { totalUsd, byAccount, comparableSeries, unpricedSeries };
}

function summarizeConsumptionWindow(
  value: ReturnType<typeof calculateConsumptionFromSamples>,
  enabledAccountCount: number,
) {
  const coveragePercent = enabledAccountCount > 0 ? (value.comparableSeries / enabledAccountCount) * 100 : 100;
  return {
    totalUsd: value.totalUsd,
    comparableSeries: value.comparableSeries,
    unpricedSeries: value.unpricedSeries,
    coveragePercent,
    zeroConsumptionReliable:
      value.totalUsd > 0 || value.comparableSeries === 0 || coveragePercent >= ZERO_CONSUMPTION_MIN_COVERAGE_PERCENT,
  };
}

export function buildConsumptionSummary(
  samples: HistoricalWindowSample[],
  nowMs: number,
  enabledAccountCount = 0,
): ConsumptionSummary {
  const ten = calculateConsumptionFromSamples(samples, 10, nowMs);
  const thirty = calculateConsumptionFromSamples(samples, 30, nowMs);
  const sixty = calculateConsumptionFromSamples(samples, 60, nowMs);
  const threeHours = calculateConsumptionFromSamples(samples, 180, nowMs);
  return {
    tenMinutes: summarizeConsumptionWindow(ten, enabledAccountCount),
    thirtyMinutes: summarizeConsumptionWindow(thirty, enabledAccountCount),
    sixtyMinutes: summarizeConsumptionWindow(sixty, enabledAccountCount),
    oneHour: summarizeConsumptionWindow(sixty, enabledAccountCount),
    threeHours: summarizeConsumptionWindow(threeHours, enabledAccountCount),
    byAccount30m: Object.fromEntries(thirty.byAccount.entries()),
  };
}

export function applyRecentConsumption(
  rows: AccountQuotaRow[],
  byAccount30m: Record<string, AccountConsumptionSummary>,
): AccountQuotaRow[] {
  return rows.map((row) => {
    const consumption = byAccount30m[`${row.cpaId}::${row.accountKey || row.name}`] ?? byAccount30m[`${row.cpaId}::${row.name}`];
    return {
      ...row,
      recent30mConsumedUsd: consumption?.usd ?? null,
      recent30mConsumptionState: consumption?.state ?? 'no-sample',
    };
  });
}

function isConsumptionReliable(window: ConsumptionSummary['thirtyMinutes']): boolean {
  return window.comparableSeries > 0 && (window.totalUsd > 0 || window.zeroConsumptionReliable);
}

function getHourlyBurnEstimate(consumption: ConsumptionSummary): {
  hourlyBurnUsd: number | null;
  oneHourBurnUsd: number | null;
  threeHourBurnUsd: number | null;
  thirtyMinuteBurnUsd: number | null;
  burnRateBasis: RiskSummary['burnRateBasis'];
  consumptionCoveragePercent: number;
  spikeDetected: boolean;
} {
  const thirtyReliable = isConsumptionReliable(consumption.thirtyMinutes);
  const oneHourReliable = isConsumptionReliable(consumption.oneHour);
  const threeHourReliable = isConsumptionReliable(consumption.threeHours);
  const thirtyMinuteBurnUsd = thirtyReliable ? consumption.thirtyMinutes.totalUsd * 2 : null;
  const oneHourBurnUsd = oneHourReliable ? consumption.oneHour.totalUsd : null;
  const threeHourBurnUsd = threeHourReliable ? consumption.threeHours.totalUsd / 3 : null;

  if (threeHourBurnUsd !== null && threeHourBurnUsd > 0) {
    const oneHourIsClearlyHigher = oneHourBurnUsd !== null && oneHourBurnUsd > threeHourBurnUsd * 1.25;
    const hourlyBurnUsd = oneHourIsClearlyHigher ? oneHourBurnUsd : threeHourBurnUsd;
    const spikeDetected =
      thirtyMinuteBurnUsd !== null && hourlyBurnUsd > 0 && thirtyMinuteBurnUsd > hourlyBurnUsd * 1.8;
    return {
      hourlyBurnUsd,
      oneHourBurnUsd,
      threeHourBurnUsd,
      thirtyMinuteBurnUsd,
      burnRateBasis: oneHourIsClearlyHigher ? 'one-hour' : 'three-hour',
      consumptionCoveragePercent: oneHourIsClearlyHigher
        ? consumption.oneHour.coveragePercent
        : consumption.threeHours.coveragePercent,
      spikeDetected,
    };
  }

  if (oneHourBurnUsd !== null && oneHourBurnUsd > 0) {
    const spikeDetected =
      thirtyMinuteBurnUsd !== null && oneHourBurnUsd > 0 && thirtyMinuteBurnUsd > oneHourBurnUsd * 1.8;
    return {
      hourlyBurnUsd: oneHourBurnUsd,
      oneHourBurnUsd,
      threeHourBurnUsd,
      thirtyMinuteBurnUsd,
      burnRateBasis: 'one-hour',
      consumptionCoveragePercent: consumption.oneHour.coveragePercent,
      spikeDetected,
    };
  }

  if (thirtyMinuteBurnUsd !== null && thirtyMinuteBurnUsd > 0) {
    return {
      hourlyBurnUsd: thirtyMinuteBurnUsd,
      oneHourBurnUsd,
      threeHourBurnUsd,
      thirtyMinuteBurnUsd,
      burnRateBasis: 'thirty-minute-spike',
      consumptionCoveragePercent: consumption.thirtyMinutes.coveragePercent,
      spikeDetected: true,
    };
  }

  if (threeHourBurnUsd === 0 || oneHourBurnUsd === 0 || thirtyMinuteBurnUsd === 0) {
    return {
      hourlyBurnUsd: 0,
      oneHourBurnUsd,
      threeHourBurnUsd,
      thirtyMinuteBurnUsd,
      burnRateBasis: 'zero',
      consumptionCoveragePercent: Math.max(
        consumption.threeHours.coveragePercent,
        consumption.oneHour.coveragePercent,
        consumption.thirtyMinutes.coveragePercent,
      ),
      spikeDetected: false,
    };
  }

  return {
    hourlyBurnUsd: null,
    oneHourBurnUsd,
    threeHourBurnUsd,
    thirtyMinuteBurnUsd,
    burnRateBasis: 'insufficient',
    consumptionCoveragePercent: Math.max(
      consumption.threeHours.coveragePercent,
      consumption.oneHour.coveragePercent,
      consumption.thirtyMinutes.coveragePercent,
    ),
    spikeDetected: false,
  };
}

export function buildPrediction(stats: MonitorStats, consumption: ConsumptionSummary): PredictionSummary {
  const burn = getHourlyBurnEstimate(consumption);
  const projectedFiveHourUsd = (burn.hourlyBurnUsd ?? 0) * 5;
  if (burn.hourlyBurnUsd === null) {
    return {
      tone: 'muted',
      title: '样本不足',
      detail: '需要更多 fresh 对比样本后才能外推未来几小时消耗。',
      projectedFiveHourUsd,
    };
  }

  if (burn.burnRateBasis === 'zero' && consumption.oneHour.totalUsd <= 0 && !consumption.oneHour.zeroConsumptionReliable) {
    return {
      tone: 'muted',
      title: '未采到消耗账号',
      detail: 'fresh 对比样本覆盖偏低，当前没有观测到消耗账号，不能按 0 消耗外推。',
      projectedFiveHourUsd,
    };
  }

  if (projectedFiveHourUsd > stats.fiveHourRemainingUsd) {
    return {
      tone: 'warn',
      title: '预计 5 小时内需要补号',
      detail: '按近 30 分钟美元消耗速率外推，当前 5h 美元容量不足。',
      projectedFiveHourUsd,
    };
  }

  return {
    tone: 'ok',
    title: '当前池容量足够',
    detail: '按近 30 分钟美元消耗速率外推，当前 5h 美元容量足够。',
    projectedFiveHourUsd,
  };
}

export function buildRiskSummary(
  rows: AccountQuotaRow[],
  stats: MonitorStats,
  consumption: ConsumptionSummary,
  nowMs: number,
  options: RiskOptions,
): RiskSummary {
  const enabledRows = rows.filter((row) => !row.disabled);
  const trustMaxMs = options.cacheTrustMaxMinutes * 60 * 1000;
  const countableRows = rows.filter(isCountableQuotaRow);
  const trustedRows = rows.filter((row) => isTrustedQuotaRow(row, nowMs, trustMaxMs));
  const freshUsableAccounts = countableRows.filter((row) => row.quotaSource === 'fresh').length;
  const trustedCachedAccounts = trustedRows.filter((row) => row.quotaSource === 'cached').length;
  const staleCachedAccounts = countableRows.filter((row) => row.quotaSource === 'cached' && !isTrustedQuotaRow(row, nowMs, trustMaxMs)).length;
  const conservativeFiveHourUsd = sumWindowUsd(trustedRows, 'fiveHour');
  const conservativeWeeklyUsd = sumWindowUsd(trustedRows, 'weekly');
  const burn = getHourlyBurnEstimate(consumption);
  const comparable = burn.hourlyBurnUsd !== null;
  const zeroConsumptionUnreliable =
    burn.burnRateBasis === 'insufficient' &&
    (consumption.thirtyMinutes.comparableSeries > 0 ||
      consumption.oneHour.comparableSeries > 0 ||
      consumption.threeHours.comparableSeries > 0);
  const hourlyBurnUsd = burn.hourlyBurnUsd;
  const projectedFiveHourSpendUsd = hourlyBurnUsd === null ? 0 : hourlyBurnUsd * options.projectionHours;
  const availableHours =
    hourlyBurnUsd === null || hourlyBurnUsd <= 0 ? null : conservativeFiveHourUsd / hourlyBurnUsd;
  const estimatedDepletionAt =
    availableHours === null || !Number.isFinite(availableHours) ? null : nowMs + availableHours * 60 * 60 * 1000;
  const projectionHours = Math.max(1, options.projectionHours);
  const curve: RiskSummary['curve'] = Array.from({ length: projectionHours + 1 }, (_, hour) => {
    const offsetMinutes = hour * 60;
    const at = nowMs + offsetMinutes * 60 * 1000;
    const consumedUsd = hourlyBurnUsd === null ? 0 : hourlyBurnUsd * hour;
    const refreshedUsd = trustedRows.reduce((sum, row) => sum + getFutureRefreshUsd(row, nowMs, at), 0);
    return {
      offsetMinutes,
      at,
      consumedUsd,
      refreshedUsd,
      projectedUsd: Math.max(0, conservativeFiveHourUsd - consumedUsd + refreshedUsd),
    };
  });
  const lowestPoint = curve.reduce((lowest, point) => (point.projectedUsd < lowest.projectedUsd ? point : lowest), curve[0]);
  const enabledCount = enabledRows.length;
  const freshCoveragePercent = enabledCount > 0 ? (freshUsableAccounts / enabledCount) * 100 : 0;
  const trustedCoveragePercent = enabledCount > 0 ? (trustedRows.length / enabledCount) * 100 : 0;
  const excludedAccounts = Math.max(0, enabledCount - trustedRows.length);

  let tone: RiskSummary['tone'] = 'ok';
  let title = '号池容量稳定';
  let detail = '按近 1-3 小时消耗趋势和未来 5h 刷新节奏估算，保守容量可以覆盖后续窗口。';

  if (!comparable) {
    tone = 'muted';
    title = '预测样本不足';
    detail = 'fresh 对比样本不足，先看保守容量和采样覆盖率，暂不做强结论。';
  } else if (zeroConsumptionUnreliable) {
    tone = 'watch';
    title = '未采到消耗账号';
    detail = 'fresh 对比样本覆盖偏低，本轮没有观测到消耗账号；这不等于账号池真实无消耗。';
  } else if (hourlyBurnUsd !== null && hourlyBurnUsd <= 0) {
    tone = trustedCoveragePercent < 60 ? 'watch' : 'ok';
    title = tone === 'watch' ? '消耗低但采样不足' : '当前消耗趋近于 0';
    detail = tone === 'watch' ? '近期未观察到明显消耗，但可用样本覆盖偏低。' : '近期未观察到明显消耗，当前无需按消耗补号。';
  } else if (availableHours !== null && availableHours <= options.emergencyAvailableHours) {
    tone = 'critical';
    title = '容量即将耗尽，紧急补号';
    detail = '按当前消耗趋势估算，账号池预计 1 小时内可能耗尽。';
  } else if (lowestPoint.projectedUsd <= 0 || (availableHours !== null && availableHours <= options.criticalAvailableHours)) {
    tone = 'critical';
    title = '容量风险严重';
    detail = '按当前消耗趋势估算，账号池预计撑不过严重预警阈值。';
  } else if (availableHours !== null && availableHours <= options.warnAvailableHours) {
    tone = 'warn';
    title = '需要准备补号';
    detail = '按当前消耗趋势估算，保守 5h 容量不足以稳定覆盖后续几小时。';
  } else if (burn.spikeDetected && availableHours !== null && availableHours <= options.warnAvailableHours * 1.5) {
    tone = 'watch';
    title = '短时消耗正在抬升';
    detail = '近 30 分钟消耗速度明显高于平滑趋势，建议关注后续一轮采样。';
  } else if (trustedCoveragePercent < 60 || staleCachedAccounts > 0) {
    tone = 'watch';
    title = '容量看起来够，但可信度偏低';
    detail = '当前账面容量包含较多过期缓存或 fresh 覆盖不足，建议等待下一轮采集或手动点击智能采集。';
  }

  return {
    tone,
    title,
    detail,
    conservativeFiveHourUsd,
    nominalFiveHourUsd: stats.fiveHourRemainingUsd,
    conservativeWeeklyUsd,
    nominalWeeklyUsd: stats.weeklyRemainingUsd,
    hourlyBurnUsd,
    oneHourBurnUsd: burn.oneHourBurnUsd,
    threeHourBurnUsd: burn.threeHourBurnUsd,
    thirtyMinuteBurnUsd: burn.thirtyMinuteBurnUsd,
    burnRateBasis: burn.burnRateBasis,
    availableHours,
    estimatedDepletionAt,
    projectedFiveHourSpendUsd,
    futureFiveHourRefreshUsd: curve[curve.length - 1]?.refreshedUsd ?? 0,
    lowestProjectedFiveHourUsd: lowestPoint.projectedUsd,
    lowestProjectedAt: lowestPoint.at,
    consumptionCoveragePercent: burn.consumptionCoveragePercent,
    spikeDetected: burn.spikeDetected,
    freshUsableAccounts,
    trustedCachedAccounts,
    staleCachedAccounts,
    excludedAccounts,
    freshCoveragePercent,
    trustedCoveragePercent,
    cacheTrustMaxMinutes: options.cacheTrustMaxMinutes,
    curve,
  };
}

export function toHistoricalWindowSample(row: AccountQuotaRow, capturedAt: number, windowId: WindowId): HistoricalWindowSample {
  const window = windowId === 'five-hour' ? row.fiveHour : row.weekly;
  const remainingUsd = window?.remainingUsd;
  const remainingPoints = window?.remainingPoints;
  const fullUsd =
    typeof remainingUsd === 'number' &&
    typeof remainingPoints === 'number' &&
    Number.isFinite(remainingUsd) &&
    Number.isFinite(remainingPoints) &&
    remainingPoints > 0
      ? remainingUsd / remainingPoints
      : null;

  return {
    name: row.name,
    accountKey: row.accountKey || row.authIndex || row.name,
    cpaId: row.cpaId,
    normalizedPlan: row.normalizedPlan,
    capturedAt,
    usedPercent: window?.usedPercent ?? null,
    resetAtMs: window?.resetAtMs ?? null,
    consumedUsdPerPoint: fullUsd,
  };
}
