import type { AccountQuotaRow, AuthFileItem } from '../shared/domain';
import {
  buildCodexQuotaRow,
  isCodexFile,
  isDisabledAuthFile,
  normalizeAuthIndex,
  parseCodexUsagePayload,
  resolveCodexAccountKey,
  resolveCodexAccountKeyCandidates,
  resolveAuthProvider,
  resolveCodexChatgptAccountId,
  resolveCodexPlanType,
} from '../shared/quota';
import { AlertMonitor } from './alertMonitor';
import type { PricingProfile } from '../shared/domain';
import { CpaClient, getApiCallErrorMessage } from './cpaClient';
import { getRiskOptions, type CpaTargetConfig, type ServerConfig } from './config';
import type { AccountCollectState, QuotaMonitorDb } from './db';

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CODEX_REQUEST_HEADERS = {
  Authorization: 'Bearer $TOKEN$',
  'Content-Type': 'application/json',
  'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
};
const LOW_FIVE_HOUR_REMAINING_POINTS = 20;

interface CollectOptions {
  forceFull?: boolean;
  coverageMode?: 'auto' | 'full-rate-limited';
}

interface CollectionCandidate {
  file: AuthFileItem;
  accountKey: string;
  accountKeys: string[];
  state: AccountCollectState | null;
  previous: AccountQuotaRow | null;
  lastSuccessAt: number | null;
  nextDueAt: number | null;
  inBackoff: boolean;
  due: boolean;
  hot: boolean;
  consumptionFollowUp: boolean;
  consumptionCoverage: boolean;
  required: boolean;
  priority: boolean;
  score: number;
}

interface CollectCodexRowsResult {
  rows: AccountQuotaRow[];
  prioritySelectedCount: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }

    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

function randomJitterMs(maxSeconds: number): number {
  if (maxSeconds <= 0) return 0;
  return Math.floor(Math.random() * maxSeconds * 1000);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicJitterMs(key: string, maxSeconds: number): number {
  if (maxSeconds <= 0) return 0;
  return hashString(key) % (maxSeconds * 1000);
}

async function mapWithJitteredConcurrency<T, R>(
  items: T[],
  concurrency: number,
  jitterSeconds: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const limit = createLimiter(Math.max(1, concurrency));
  await Promise.all(
    items.map(async (item, index) => {
      const delayMs = randomJitterMs(jitterSeconds);
      if (delayMs > 0) await sleep(delayMs);
      results[index] = await limit(() => mapper(item));
    }),
  );
  return results;
}

async function mapWithRateLimitedJitteredConcurrency<T, R>(
  items: T[],
  concurrency: number,
  requestsPerMinute: number,
  jitterSeconds: number,
  mapper: (item: T) => Promise<R>,
  consumesRequestSlot: (item: T) => boolean = () => true,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const limit = createLimiter(Math.max(1, concurrency));
  const spacingMs = 60_000 / Math.max(0.1, requestsPerMinute);
  const launchJitterSeconds = Math.min(jitterSeconds, 10);
  let requestSlot = 0;

  await Promise.all(
    items.map(async (item, index) => {
      if (!consumesRequestSlot(item)) {
        results[index] = await mapper(item);
        return;
      }

      const slot = requestSlot;
      requestSlot += 1;
      const delayMs = slot * spacingMs + randomJitterMs(launchJitterSeconds);
      if (delayMs > 0) await sleep(delayMs);
      results[index] = await limit(() => mapper(item));
    }),
  );

  return results;
}

function getBackoffKey(target: CpaTargetConfig, file: AuthFileItem): string {
  return `${target.id}::${getAccountKey(file)}`;
}

function getAccountKey(file: AuthFileItem): string {
  return resolveCodexAccountKey(file);
}

function getAccountKeys(file: AuthFileItem): string[] {
  return resolveCodexAccountKeyCandidates(file);
}

function findState(
  states: Map<string, AccountCollectState>,
  accountKeys: string[],
  previous: AccountQuotaRow | null,
): AccountCollectState | null {
  const primary = accountKeys[0];
  const primaryState = primary ? states.get(primary) : null;
  if (primaryState) return primaryState;
  if (!previous) return null;
  for (const key of accountKeys.slice(1)) {
    const state = states.get(key);
    if (state) return state;
  }
  return null;
}

function findReusableRow(
  reusableRows: Map<string, AccountQuotaRow>,
  accountKeys: string[],
  currentAccountId: string | null,
): AccountQuotaRow | null {
  for (const key of accountKeys) {
    const row = reusableRows.get(key);
    if (!row) continue;
    if (!currentAccountId || !row.accountId || row.accountId === currentAccountId) return row;
  }
  return null;
}

function getMemoryBackoffUntil(target: CpaTargetConfig, accountKeys: string[], accountBackoffUntil: Map<string, number>): number {
  return accountKeys.reduce((max, key) => Math.max(max, accountBackoffUntil.get(`${target.id}::${key}`) ?? 0), 0);
}

function formatBackoffUntil(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function shouldBackoffAccount(message: string | null): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();
  return (
    /\b(401|403|429)\b/.test(normalized) ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden') ||
    normalized.includes('too many requests') ||
    normalized.includes('rate limit')
  );
}

function withQuotaSource(
  row: AccountQuotaRow,
  source: AccountQuotaRow['quotaSource'],
  nowMs: number,
  options: { sampledAt?: number | null; backoffUntil?: number | null; error?: string | null } = {},
): AccountQuotaRow {
  const quotaSampledAt = options.sampledAt === undefined ? row.quotaSampledAt : options.sampledAt;
  return {
    ...row,
    quotaSource: source,
    quotaSampledAt,
    quotaAgeMs: quotaSampledAt === null || quotaSampledAt === undefined ? null : Math.max(0, nowMs - quotaSampledAt),
    backoffUntil: options.backoffUntil === undefined ? row.backoffUntil : options.backoffUntil,
    error: options.error === undefined ? row.error : options.error,
  };
}

function copyPreviousQuotaRow(
  target: CpaTargetConfig,
  file: AuthFileItem,
  previous: AccountQuotaRow,
  source: AccountQuotaRow['quotaSource'],
  nowMs: number,
  error: string | null,
  backoffUntil: number | null = null,
): AccountQuotaRow {
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  const planType = resolveCodexPlanType(file) ?? previous.planType;
  const accountId = resolveCodexChatgptAccountId(file) ?? previous.accountId;
  const sampledAt = previous.quotaSampledAt;
  return {
    ...previous,
    cpaId: target.id,
    cpaName: target.name,
    accountKey: getAccountKey(file),
    name: file.name,
    provider: resolveAuthProvider(file),
    authIndex,
    accountId,
    disabled: isDisabledAuthFile(file),
    planType,
    quotaSource: source,
    quotaSampledAt: sampledAt,
    quotaAgeMs: sampledAt !== null && sampledAt !== undefined ? Math.max(0, nowMs - sampledAt) : null,
    backoffUntil,
    error,
  };
}

function buildPendingRow(
  target: CpaTargetConfig,
  file: AuthFileItem,
  pricingProfile: PricingProfile,
  nowMs: number,
): AccountQuotaRow {
  const row = withQuotaSource(
    buildCodexQuotaRow(
      target.id,
      target.name,
      file,
      { plan_type: resolveCodexPlanType(file) },
      pricingProfile,
      nowMs,
      '等待智能轮询采集',
    ),
    'pending',
    nowMs,
    { sampledAt: null, error: '等待智能轮询采集' },
  );
  return { ...row, status: 'unknown' };
}

function getCandidateScore(
  candidate: CollectionCandidate,
  nowMs: number,
  collectIntervalMinutes: number,
  recentlyConsumedKeys: Set<string>,
): number {
  if (candidate.required) {
    const lastSuccessAt = candidate.state?.lastSuccessAt ?? 0;
    return 100_000 + (nowMs - lastSuccessAt) / 60_000;
  }

  let score = 0;
  const lastSuccessAt = candidate.state?.lastSuccessAt ?? 0;
  score += (nowMs - lastSuccessAt) / 60_000;

  const remainingPoints = candidate.previous?.fiveHour?.remainingPoints;
  if (typeof remainingPoints === 'number' && remainingPoints <= LOW_FIVE_HOUR_REMAINING_POINTS) score += 2_000;

  if (recentlyConsumedKeys.has(candidate.accountKey)) score += 1_500;
  if (candidate.consumptionFollowUp) score += 3_000;
  if (candidate.consumptionCoverage) score += 500;

  const resetAtMs = candidate.previous?.fiveHour?.resetAtMs;
  const resetSoonWindowMs = Math.max(collectIntervalMinutes * 2, 30) * 60 * 1000;
  if (typeof resetAtMs === 'number' && resetAtMs <= nowMs + resetSoonWindowMs) score += 1_000;

  return score;
}

function getContinuousCandidateScore(candidate: CollectionCandidate, nowMs: number): number {
  if (candidate.inBackoff || !candidate.due) return Number.NEGATIVE_INFINITY;
  const lastSuccessAt = candidate.lastSuccessAt ?? 0;
  const nextDueAt = candidate.nextDueAt ?? nowMs;
  let score = Math.max(0, nowMs - nextDueAt) / 60_000;
  if (!candidate.previous || !candidate.lastSuccessAt) score += 100_000;
  if (candidate.required) score += 50_000;
  if (candidate.hot) score += 20_000;
  score += Math.max(0, nowMs - lastSuccessAt) / 60_000;
  return score;
}

function withCollectNextDueAt(row: AccountQuotaRow, nextDueAt: number | null): AccountQuotaRow {
  return { ...row, collectNextDueAt: nextDueAt } as AccountQuotaRow;
}

function withCollectAttemptedFailure(row: AccountQuotaRow): AccountQuotaRow {
  return { ...row, collectAttemptedFailure: true } as AccountQuotaRow;
}

async function fetchCodexRow(
  client: CpaClient,
  target: CpaTargetConfig,
  file: AuthFileItem,
  pricingProfile: PricingProfile,
  snapshotAt: number,
): Promise<AccountQuotaRow> {
  if (isDisabledAuthFile(file)) {
    return buildCodexQuotaRow(target.id, target.name, file, null, pricingProfile, snapshotAt);
  }

  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  if (!authIndex) {
    return buildCodexQuotaRow(
      target.id,
      target.name,
      file,
      null,
      pricingProfile,
      snapshotAt,
      '缺少 auth_index，无法通过 api-call 获取额度',
    );
  }

  try {
    const accountId = resolveCodexChatgptAccountId(file);
    const requestHeader: Record<string, string> = { ...CODEX_REQUEST_HEADERS };
    if (accountId) requestHeader['Chatgpt-Account-Id'] = accountId;

    const result = await client.apiCall({
      authIndex,
      method: 'GET',
      url: CODEX_USAGE_URL,
      header: requestHeader,
    });

    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(getApiCallErrorMessage(result));
    }

    const payload = parseCodexUsagePayload(result.body ?? result.bodyText);
    return buildCodexQuotaRow(target.id, target.name, file, payload, pricingProfile, Date.now());
  } catch (error) {
    return buildCodexQuotaRow(
      target.id,
      target.name,
      file,
      { plan_type: resolveCodexPlanType(file) },
      pricingProfile,
      Date.now(),
      error instanceof Error ? error.message : '获取额度失败',
    );
  }
}

export class QuotaCollector {
  private config: ServerConfig;
  private db: QuotaMonitorDb;
  private timer: ReturnType<typeof setInterval> | null = null;
  private runningTargets = new Set<string>();
  private runningTargetModes = new Map<string, 'auto' | 'full-rate-limited'>();
  private pendingFullCoverageTargets = new Set<string>();
  private accountBackoffUntil = new Map<string, number>();
  private nextUsageRequestAt = 0;
  private alertMonitor: AlertMonitor;

  constructor(config: ServerConfig, db: QuotaMonitorDb) {
    this.config = config;
    this.db = db;
    this.alertMonitor = new AlertMonitor(config);
  }

  start(): void {
    void this.collectAll();
    this.timer = setInterval(() => {
      void this.collectAll();
    }, this.getCollectTickMs());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async collectAll(options: CollectOptions = {}): Promise<void> {
    if (this.config.collectStrategy === 'continuous' || this.isFullCoverageRun(options)) {
      for (const target of this.config.targets) {
        await this.collectTarget(target, options);
      }
      return;
    }
    await Promise.all(this.config.targets.map((target) => this.collectTarget(target, options)));
  }

  async collectTarget(target: CpaTargetConfig, options: CollectOptions = {}): Promise<number | null> {
    const fullCoverage = this.isFullCoverageRun(options);
    if (this.runningTargets.has(target.id)) {
      if (fullCoverage && this.runningTargetModes.get(target.id) !== 'full-rate-limited') {
        this.pendingFullCoverageTargets.add(target.id);
      }
      return null;
    }

    this.runningTargets.add(target.id);
    this.runningTargetModes.set(target.id, fullCoverage ? 'full-rate-limited' : 'auto');
    const startedAt = Date.now();
    const nextRunAt = startedAt + this.getCollectTickMs();
    this.db.updateCollectorState(target, {
      status: 'collecting',
      lastStartedAt: startedAt,
      nextRunAt,
      lastError: null,
      progressCompletedAccounts: 0,
      progressTotalAccounts: null,
    });

    try {
      const pricingProfile = this.db.getPricingProfile();
      const client = new CpaClient(target, this.config.cpaRequestTimeoutSeconds * 1000);
      const authFiles = await client.listAuthFiles();
      const codexFiles = authFiles.filter(isCodexFile);
      const { rows, prioritySelectedCount } = await this.collectCodexRows(
        client,
        target,
        codexFiles,
        pricingProfile,
        startedAt,
        options,
      );
      const errors = rows
        .filter((row) => row.error)
        .slice(0, 5)
        .map((row) => `${row.name}: ${row.error}`);
      const strategy = this.getRunStrategy(options);
      const snapshotId = this.db.saveSnapshot(
        target,
        startedAt,
        rows,
        strategy,
        errors.length ? errors.join('\n') : null,
        prioritySelectedCount,
      );
      this.db.pruneHistory(Date.now());
      this.db.updateCollectorState(target, {
        status: 'ok',
        lastCompletedAt: Date.now(),
        nextRunAt,
        lastError: null,
        progressCompletedAccounts: null,
        progressTotalAccounts: null,
      });
      const latest = this.db.getLatestPayload(this.config.targets, target.id, getRiskOptions(this.config));
      try {
        await this.alertMonitor.evaluateTarget(target, latest);
      } catch (alertError) {
        const message = alertError instanceof Error ? alertError.message : '短信预警处理失败';
        console.error(`Failed to evaluate SMS alerts for ${target.name}: ${message}`);
      }
      return snapshotId;
    } catch (error) {
      const message = error instanceof Error ? error.message : '采集失败';
      this.db.updateCollectorState(target, {
        status: 'error',
        lastCompletedAt: Date.now(),
        nextRunAt,
        lastError: message,
        progressCompletedAccounts: null,
        progressTotalAccounts: null,
      });
      return null;
    } finally {
      this.runningTargets.delete(target.id);
      this.runningTargetModes.delete(target.id);
      if (this.pendingFullCoverageTargets.delete(target.id)) {
        void this.collectTarget(target, { coverageMode: 'full-rate-limited' });
      }
    }
  }

  private async collectCodexRows(
    client: CpaClient,
    target: CpaTargetConfig,
    codexFiles: AuthFileItem[],
    pricingProfile: PricingProfile,
    startedAt: number,
    options: CollectOptions,
  ): Promise<CollectCodexRowsResult> {
    const states = this.db.getAccountCollectStates(target.id);
    const reusableRows = this.db.getLatestReusableAccounts(target.id, pricingProfile);
    const recentlyConsumedKeys = this.db.getRecentlyConsumedAccountKeys(target.id, startedAt);
    const fullCoverage = this.isFullCoverageRun(options);
    const continuous = this.config.collectStrategy === 'continuous' && !fullCoverage;
    const activeFiles = codexFiles.filter((file) => !isDisabledAuthFile(file));
    const activeCount = activeFiles.length;
    const baseQueryBudget = fullCoverage
      ? activeCount
      : continuous
        ? activeCount
        : Math.max(1, Math.ceil((activeCount * this.config.collectSamplePercent) / 100));
    const consumptionQueryBudget =
      !fullCoverage && !continuous && this.config.collectConsumptionSamplePercent > 0
        ? Math.ceil((activeCount * this.config.collectConsumptionSamplePercent) / 100)
        : 0;
    let queryBudget = fullCoverage ? activeCount : Math.max(baseQueryBudget, consumptionQueryBudget);
    const consumptionWindowMs = this.config.collectConsumptionWindowMinutes * 60 * 1000;
    const consumptionFollowUpMinAgeMs = Math.max(5, Math.floor(this.config.collectIntervalMinutes / 2)) * 60 * 1000;
    const normalIntervalMs = this.config.collectUsageNormalMinIntervalMinutes * 60 * 1000;
    const hotIntervalMs = this.config.collectUsageHotMinIntervalMinutes * 60 * 1000;
    const maxStaleMs = this.config.collectUsageMaxStalenessMinutes * 60 * 1000;
    const initialOrder = new Map(
      [...activeFiles]
        .sort((left, right) => hashString(getAccountKey(left)) - hashString(getAccountKey(right)))
        .map((file, index) => [getAccountKey(file), index]),
    );
    const initialSpacingMs = activeCount > 0 ? Math.max(1_000, Math.floor(normalIntervalMs / activeCount)) : normalIntervalMs;
    const candidates = activeFiles.map((file) => {
      const accountKey = getAccountKey(file);
      const accountKeys = getAccountKeys(file);
      const accountId = resolveCodexChatgptAccountId(file);
      const previous = findReusableRow(reusableRows, accountKeys, accountId);
      const state = findState(states, accountKeys, previous);
      const backoffUntil = Math.max(
        state?.backoffUntil ?? 0,
        getMemoryBackoffUntil(target, accountKeys, this.accountBackoffUntil),
      );
      const inBackoff = backoffUntil > startedAt;
      const lastSuccessAt = state?.lastSuccessAt ?? previous?.quotaSampledAt ?? null;
      const successAgeMs = lastSuccessAt === null ? Number.POSITIVE_INFINITY : startedAt - lastSuccessAt;
      const remainingPoints = previous?.fiveHour?.remainingPoints;
      const resetAtMs = previous?.fiveHour?.resetAtMs;
      const resetSoonWindowMs = Math.max(this.config.collectUsageNormalMinIntervalMinutes, 30) * 60 * 1000;
      const hot =
        recentlyConsumedKeys.has(accountKey) ||
        (typeof remainingPoints === 'number' && remainingPoints <= LOW_FIVE_HOUR_REMAINING_POINTS) ||
        (typeof resetAtMs === 'number' && resetAtMs <= startedAt + resetSoonWindowMs);
      const consumptionFollowUp =
        !inBackoff &&
        lastSuccessAt !== null &&
        successAgeMs >= consumptionFollowUpMinAgeMs &&
        successAgeMs <= consumptionWindowMs;
      const consumptionCoverage = !inBackoff && (lastSuccessAt === null || successAgeMs > consumptionWindowMs);
      const intervalMs = hot ? hotIntervalMs : normalIntervalMs;
      const initialIndex = initialOrder.get(accountKey) ?? 0;
      const initialDueAt = startedAt + initialIndex * initialSpacingMs;
      const scheduledDueAt =
        state?.nextDueAt ??
        (lastSuccessAt === null
          ? initialDueAt
          : lastSuccessAt + intervalMs + deterministicJitterMs(accountKey, this.config.collectJitterSeconds));
      const priority = !inBackoff && (!previous || !lastSuccessAt || state?.quotaSource === 'paused');
      const stale =
        lastSuccessAt !== null &&
        startedAt - lastSuccessAt >= (continuous ? maxStaleMs : this.config.collectMaxStaleMinutes * 60 * 1000);
      const due =
        !inBackoff &&
        (scheduledDueAt <= startedAt ||
          stale ||
          state?.quotaSource === 'failed' ||
          state?.quotaSource === 'backoff');
      const required =
        !inBackoff &&
        ((priority && due) ||
          stale ||
          state?.quotaSource === 'failed' ||
          state?.quotaSource === 'backoff');
      const candidate: CollectionCandidate = {
        file,
        accountKey,
        accountKeys,
        state,
        previous,
        lastSuccessAt,
        nextDueAt: scheduledDueAt,
        inBackoff,
        due,
        hot,
        consumptionFollowUp,
        consumptionCoverage,
        required,
        priority,
        score: 0,
      };
      return {
        ...candidate,
        score: inBackoff
          ? Number.NEGATIVE_INFINITY
          : continuous
            ? getContinuousCandidateScore(candidate, startedAt)
            : getCandidateScore(candidate, startedAt, this.config.collectIntervalMinutes, recentlyConsumedKeys),
      };
    });
    const eligibleCandidates = candidates
      .filter((candidate) => candidate.score > Number.NEGATIVE_INFINITY)
      .sort((left, right) => right.score - left.score);
    if (continuous) {
      queryBudget = this.reserveUsageRequestSlots(startedAt, eligibleCandidates.length);
    }
    const selectedKeys = new Set(
      fullCoverage
        ? activeFiles.map((file) => getAccountKey(file))
        : eligibleCandidates.slice(0, queryBudget).map((candidate) => candidate.accountKey),
    );
    if (!fullCoverage && !continuous && this.config.collectNewAccountBurst > 0) {
      eligibleCandidates
        .filter((candidate) => candidate.priority && !selectedKeys.has(candidate.accountKey))
        .slice(0, this.config.collectNewAccountBurst)
        .forEach((candidate) => selectedKeys.add(candidate.accountKey));
    }
    const prioritySelectedCount = candidates.filter(
      (candidate) => candidate.priority && selectedKeys.has(candidate.accountKey),
    ).length;
    const candidatesByKey = new Map(candidates.map((candidate) => [candidate.accountKey, candidate]));
    const selectedFiles = activeFiles.filter((file) => selectedKeys.has(getAccountKey(file)));
    let completedRequests = 0;
    this.db.updateCollectorState(target, {
      progressCompletedAccounts: 0,
      progressTotalAccounts: selectedFiles.length,
    });
    const fetchSelectedFile = async (file: AuthFileItem) => {
      const row = await this.fetchCodexRowWithBackoff(client, target, file, pricingProfile, startedAt, states, reusableRows);
      completedRequests += 1;
      this.db.updateCollectorState(target, {
        progressCompletedAccounts: completedRequests,
        progressTotalAccounts: selectedFiles.length,
      });
      return row;
    };
    const fetchedRows = fullCoverage
      ? await mapWithRateLimitedJitteredConcurrency(
          selectedFiles,
          this.config.collectManualConcurrency,
          this.config.collectManualMaxRequestsPerMinute,
          this.config.collectJitterSeconds,
          fetchSelectedFile,
          (file) => !candidatesByKey.get(getAccountKey(file))?.inBackoff,
        )
      : continuous
        ? await mapWithRateLimitedJitteredConcurrency(
            selectedFiles,
            this.config.collectConcurrency,
            this.config.collectUsageMaxRequestsPerMinute,
            this.config.collectJitterSeconds,
            fetchSelectedFile,
          )
      : await mapWithJitteredConcurrency(
          selectedFiles,
          this.config.collectConcurrency,
          this.config.collectJitterSeconds,
          fetchSelectedFile,
        );
    const fetchedByKey = new Map(
      fetchedRows.map((row) => {
        const candidate = candidatesByKey.get(row.accountKey);
        return [row.accountKey, withCollectNextDueAt(row, this.getNextDueAtForFetchedRow(row, candidate, Date.now()))];
      }),
    );

    const rows = codexFiles.map((file) => {
      const accountKey = getAccountKey(file);
      const accountKeys = getAccountKeys(file);
      if (isDisabledAuthFile(file)) {
        return withCollectNextDueAt(buildCodexQuotaRow(target.id, target.name, file, null, pricingProfile, startedAt), null);
      }

      const fetched = fetchedByKey.get(accountKey);
      if (fetched) return fetched;

      const accountId = resolveCodexChatgptAccountId(file);
      const previous = findReusableRow(reusableRows, accountKeys, accountId);
      const state = findState(states, accountKeys, previous);
      const candidate = candidatesByKey.get(accountKey);
      const nextDueAt = candidate?.nextDueAt ?? state?.nextDueAt ?? null;
      const backoffUntil = Math.max(
        state?.backoffUntil ?? 0,
        getMemoryBackoffUntil(target, accountKeys, this.accountBackoffUntil),
      );
      if (backoffUntil > startedAt) {
        const message = `账号 usage 查询退避中，将在 ${formatBackoffUntil(backoffUntil)} 后重试`;
        return previous
          ? withCollectNextDueAt(copyPreviousQuotaRow(target, file, previous, 'backoff', startedAt, message, backoffUntil), backoffUntil)
          : withQuotaSource(buildPendingRow(target, file, pricingProfile, startedAt), 'backoff', startedAt, {
              backoffUntil,
              error: message,
            });
      }

      if (previous) return withCollectNextDueAt(copyPreviousQuotaRow(target, file, previous, 'cached', startedAt, null), nextDueAt);
      return withCollectNextDueAt(buildPendingRow(target, file, pricingProfile, startedAt), nextDueAt);
    });
    return { rows, prioritySelectedCount };
  }

  private async fetchCodexRowWithBackoff(
    client: CpaClient,
    target: CpaTargetConfig,
    file: AuthFileItem,
    pricingProfile: PricingProfile,
    nowMs: number,
    states: Map<string, AccountCollectState>,
    reusableRows: Map<string, AccountQuotaRow>,
  ): Promise<AccountQuotaRow> {
    if (isDisabledAuthFile(file)) {
      return fetchCodexRow(client, target, file, pricingProfile, nowMs);
    }

    const accountKeys = getAccountKeys(file);
    const accountId = resolveCodexChatgptAccountId(file);
    const previous = findReusableRow(reusableRows, accountKeys, accountId);
    const state = findState(states, accountKeys, previous);
    const backoffKey = getBackoffKey(target, file);
    const stateBackoffUntil = state?.backoffUntil ?? 0;
    const backoffUntil = Math.max(getMemoryBackoffUntil(target, accountKeys, this.accountBackoffUntil), stateBackoffUntil);
    if (backoffUntil > Date.now()) {
      const message = `账号 usage 查询退避中，将在 ${formatBackoffUntil(backoffUntil)} 后重试`;
      return previous
        ? copyPreviousQuotaRow(target, file, previous, 'backoff', nowMs, message, backoffUntil)
        : withQuotaSource(buildPendingRow(target, file, pricingProfile, nowMs), 'backoff', nowMs, {
            backoffUntil,
            error: message,
          });
    }

    const row = await fetchCodexRow(client, target, file, pricingProfile, nowMs);
    if (row.error && this.config.collectUsageErrorBackoffMinutes > 0 && shouldBackoffAccount(row.error)) {
      const failureCount = (state?.failureCount ?? 0) + 1;
      const backoffMinutes = Math.min(
        this.config.collectUsageErrorBackoffMaxMinutes,
        this.config.collectUsageErrorBackoffMinutes * 2 ** Math.max(0, failureCount - 1),
      );
      const nextBackoffUntil = Date.now() + backoffMinutes * 60 * 1000 + randomJitterMs(this.config.collectJitterSeconds);
      this.accountBackoffUntil.set(backoffKey, nextBackoffUntil);
      if (previous) {
        return withCollectAttemptedFailure(
          copyPreviousQuotaRow(target, file, previous, 'backoff', nowMs, row.error, nextBackoffUntil),
        );
      }
      return withCollectAttemptedFailure(
        withQuotaSource(row, 'backoff', nowMs, {
          sampledAt: row.quotaSampledAt ?? nowMs,
          backoffUntil: nextBackoffUntil,
        }),
      );
    } else if (!row.error) {
      accountKeys.forEach((key) => this.accountBackoffUntil.delete(`${target.id}::${key}`));
    }
    const sourcedRow = withQuotaSource(row, row.error ? 'failed' : 'fresh', nowMs, {
      sampledAt: row.quotaSampledAt ?? nowMs,
      backoffUntil: null,
    });
    return row.error ? withCollectAttemptedFailure(sourcedRow) : sourcedRow;
  }

  private getCollectTickMs(): number {
    if (this.config.collectStrategy === 'continuous') {
      return Math.max(5, this.config.collectUsageTickSeconds) * 1000;
    }
    return this.config.collectIntervalMinutes * 60 * 1000;
  }

  private getRunStrategy(options: CollectOptions): 'adaptive' | 'continuous' | 'full' {
    if (this.isFullCoverageRun(options)) return 'full';
    return this.config.collectStrategy === 'continuous' ? 'continuous' : 'adaptive';
  }

  private isFullCoverageRun(options: CollectOptions): boolean {
    return options.coverageMode === 'full-rate-limited' || options.forceFull === true || this.config.collectStrategy === 'full';
  }

  private reserveUsageRequestSlots(nowMs: number, requested: number): number {
    if (requested <= 0) return 0;
    const requestsPerMinute = Math.max(0.1, this.config.collectUsageMaxRequestsPerMinute);
    const spacingMs = 60_000 / requestsPerMinute;
    const toleranceMs = Math.min(5_000, this.getCollectTickMs() * 0.05);
    if (nowMs + toleranceMs < this.nextUsageRequestAt) return 0;
    const maxPerTick = Math.max(1, Math.floor((requestsPerMinute * Math.max(5, this.config.collectUsageTickSeconds)) / 60));
    const slots = Math.min(requested, maxPerTick);
    this.nextUsageRequestAt = nowMs + spacingMs * slots;
    return slots;
  }

  private getNextDueAtForFetchedRow(
    row: AccountQuotaRow,
    candidate: CollectionCandidate | undefined,
    nowMs: number,
  ): number | null {
    if (row.disabled || row.status === 'paused') return null;
    if (row.quotaSource === 'backoff' && row.backoffUntil) return row.backoffUntil;
    if (row.quotaSource === 'failed') {
      return nowMs + this.config.collectUsageErrorBackoffMinutes * 60 * 1000 + randomJitterMs(this.config.collectJitterSeconds);
    }
    const intervalMinutes = candidate?.hot
      ? this.config.collectUsageHotMinIntervalMinutes
      : this.config.collectUsageNormalMinIntervalMinutes;
    return nowMs + intervalMinutes * 60 * 1000 + randomJitterMs(this.config.collectJitterSeconds);
  }
}
