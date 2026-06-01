export type WindowId = 'five-hour' | 'weekly';
export type AccountQuotaStatus = 'active' | 'paused' | 'failed' | 'unknown';
export type PlanKey = 'free' | 'plus' | 'team' | 'pro' | 'unknown';
export type CollectorStatus = 'idle' | 'collecting' | 'ok' | 'error';
export type QuotaSource = 'fresh' | 'cached' | 'paused' | 'failed' | 'backoff' | 'pending';
export type ConsumptionSampleState = 'priced' | 'no-sample' | 'unpriced';
export type RiskTone = 'ok' | 'watch' | 'warn' | 'critical' | 'muted';

export interface CpaTarget {
  id: string;
  name: string;
  apiBase: string;
}

export interface AuthFileItem {
  name: string;
  type?: string;
  provider?: string;
  authIndex?: string | number | null;
  runtimeOnly?: boolean | string;
  disabled?: boolean | number | string;
  unavailable?: boolean;
  status?: string;
  statusMessage?: string;
  metadata?: unknown;
  attributes?: unknown;
  id_token?: unknown;
  plan_type?: unknown;
  planType?: unknown;
  [key: string]: unknown;
}

export interface QuotaWindowState {
  id: WindowId;
  usedPercent: number | null;
  remainingPoints: number | null;
  remainingUsd: number | null;
  resetAtMs: number | null;
  priced: boolean;
}

export interface AccountQuotaRow {
  cpaId: string;
  cpaName: string;
  accountKey: string;
  name: string;
  provider: string;
  authIndex: string | null;
  accountId: string | null;
  disabled: boolean;
  status: AccountQuotaStatus;
  planType: string | null;
  normalizedPlan: PlanKey;
  fiveHour: QuotaWindowState | null;
  weekly: QuotaWindowState | null;
  recent30mConsumedUsd: number | null;
  recent30mConsumptionState: ConsumptionSampleState;
  quotaSource: QuotaSource;
  quotaSampledAt: number | null;
  quotaAgeMs: number | null;
  backoffUntil: number | null;
  error: string | null;
}

export interface MonitorStats {
  totalAccounts: number;
  enabledAccounts: number;
  pausedAccounts: number;
  failedOrUnknownAccounts: number;
  successfulAccounts: number;
  fiveHourRemainingPoints: number;
  weeklyRemainingPoints: number;
  fiveHourRemainingUsd: number;
  weeklyRemainingUsd: number;
  unpricedFiveHourAccounts: number;
  unpricedWeeklyAccounts: number;
}

export interface RefreshBucket {
  bucket: string;
  sortMinute: number;
  fiveHourAccounts: string[];
  weeklyAccounts: string[];
}

export interface PlanWindowPricing {
  fiveHourUsd: number | null;
  weeklyUsd: number | null;
}

export interface PricingProfile {
  id: string;
  name: string;
  sourceLabel: string;
  updatedAt: number;
  plans: Record<Exclude<PlanKey, 'unknown'>, PlanWindowPricing>;
}

export interface CollectorState {
  status: CollectorStatus;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastError: string | null;
  nextRunAt: number | null;
  progressCompletedAccounts: number | null;
  progressTotalAccounts: number | null;
}

export interface CollectionRunSummary {
  strategy: 'adaptive' | 'continuous' | 'full';
  enabledAccounts: number;
  freshAccounts: number;
  cachedAccounts: number;
  backoffAccounts: number;
  pendingAccounts: number;
  failedAccounts: number;
  priorityAccounts: number;
}

export interface SnapshotSummary {
  id: number;
  cpaId: string;
  cpaName: string;
  capturedAt: number;
  stats: MonitorStats;
  collection: CollectionRunSummary;
  errorSummary: string | null;
}

export interface ConsumptionWindowSummary {
  totalUsd: number;
  comparableSeries: number;
  unpricedSeries: number;
  coveragePercent: number;
  zeroConsumptionReliable: boolean;
}

export interface ConsumptionSummary {
  tenMinutes: ConsumptionWindowSummary;
  thirtyMinutes: ConsumptionWindowSummary;
  sixtyMinutes: ConsumptionWindowSummary;
  oneHour: ConsumptionWindowSummary;
  threeHours: ConsumptionWindowSummary;
  byAccount30m: Record<string, AccountConsumptionSummary>;
}

export interface AccountConsumptionSummary {
  usd: number | null;
  state: ConsumptionSampleState;
}

export interface PredictionSummary {
  tone: 'ok' | 'warn' | 'muted';
  title: string;
  detail: string;
  projectedFiveHourUsd: number;
}

export interface RiskOptions {
  cacheTrustMaxMinutes: number;
  warnAvailableHours: number;
  criticalAvailableHours: number;
  emergencyAvailableHours: number;
  projectionHours: number;
}

export interface CapacityCurvePoint {
  offsetMinutes: number;
  at: number;
  projectedUsd: number;
  consumedUsd: number;
  refreshedUsd: number;
}

export interface RiskSummary {
  tone: RiskTone;
  title: string;
  detail: string;
  conservativeFiveHourUsd: number;
  nominalFiveHourUsd: number;
  conservativeWeeklyUsd: number;
  nominalWeeklyUsd: number;
  hourlyBurnUsd: number | null;
  oneHourBurnUsd: number | null;
  threeHourBurnUsd: number | null;
  thirtyMinuteBurnUsd: number | null;
  burnRateBasis: 'three-hour' | 'one-hour' | 'thirty-minute-spike' | 'zero' | 'insufficient';
  availableHours: number | null;
  estimatedDepletionAt: number | null;
  projectedFiveHourSpendUsd: number;
  futureFiveHourRefreshUsd: number;
  lowestProjectedFiveHourUsd: number | null;
  lowestProjectedAt: number | null;
  consumptionCoveragePercent: number;
  spikeDetected: boolean;
  freshUsableAccounts: number;
  trustedCachedAccounts: number;
  staleCachedAccounts: number;
  excludedAccounts: number;
  freshCoveragePercent: number;
  trustedCoveragePercent: number;
  cacheTrustMaxMinutes: number;
  curve: CapacityCurvePoint[];
}

export interface LatestPayload {
  targets: CpaTarget[];
  selectedCpaId: string;
  snapshot: SnapshotSummary | null;
  accounts: AccountQuotaRow[];
  refreshBuckets: RefreshBucket[];
  consumption: ConsumptionSummary;
  prediction: PredictionSummary;
  risk: RiskSummary;
  pricingProfile: PricingProfile;
  collectorState: CollectorState;
}

export interface SessionPayload {
  authenticated: boolean;
}
