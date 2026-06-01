import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import type {
  AccountQuotaRow,
  CollectionRunSummary,
  CollectorState,
  CpaTarget,
  LatestPayload,
  PricingProfile,
  QuotaSource,
  RiskOptions,
  SnapshotSummary,
} from '../shared/domain';
import {
  applyRecentConsumption,
  buildConsumptionSummary,
  buildMonitorStats,
  buildPrediction,
  buildRefreshBuckets,
  buildRiskSummary,
} from '../shared/analytics';
import { calculateWindowUsd, DEFAULT_PRICING_PROFILE, normalizePricingProfile } from '../shared/pricing';
import type { CpaTargetConfig } from './config';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RESET_MATCH_TOLERANCE_MS = 2 * 60 * 1000;

type DbRow = Record<string, unknown>;

export interface AccountCollectState {
  accountKey: string;
  accountName: string;
  authIndex: string | null;
  lastQuotaSampledAt: number | null;
  lastSuccessAt: number | null;
  nextDueAt: number | null;
  failureCount: number;
  lastError: string | null;
  quotaSource: QuotaSource;
  backoffUntil: number | null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === 1 || value === true;
}

function normalizeQuotaSource(value: unknown): QuotaSource {
  if (
    value === 'fresh' ||
    value === 'cached' ||
    value === 'paused' ||
    value === 'failed' ||
    value === 'backoff' ||
    value === 'pending'
  ) {
    return value;
  }
  return 'fresh';
}

function getAccountKeyFromRow(row: DbRow): string {
  return String(row.account_key ?? row.auth_index ?? row.account_name);
}

function getAccountKeyFromQuotaRow(row: AccountQuotaRow): string {
  return row.accountKey || row.authIndex || row.name;
}

function jsonStringify(value: unknown): string {
  return JSON.stringify(value);
}

function parsePricingRow(row: DbRow | null | undefined): PricingProfile {
  if (!row) {
    return { ...DEFAULT_PRICING_PROFILE, updatedAt: Date.now() };
  }
  try {
    const parsed = JSON.parse(String(row.profile_json)) as PricingProfile;
    return normalizePricingProfile(parsed);
  } catch {
    return { ...DEFAULT_PRICING_PROFILE, updatedAt: Date.now() };
  }
}

function makeEmptyCollectorState(): CollectorState {
  return {
    status: 'idle',
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    nextRunAt: null,
    progressCompletedAccounts: null,
    progressTotalAccounts: null,
  };
}

function buildCollectionSummary(
  rows: AccountQuotaRow[],
  strategy: CollectionRunSummary['strategy'],
  priorityAccounts: number,
): CollectionRunSummary {
  return {
    strategy,
    enabledAccounts: rows.filter((row) => !row.disabled).length,
    freshAccounts: rows.filter((row) => row.quotaSource === 'fresh').length,
    cachedAccounts: rows.filter((row) => row.quotaSource === 'cached').length,
    backoffAccounts: rows.filter((row) => row.quotaSource === 'backoff').length,
    pendingAccounts: rows.filter((row) => row.quotaSource === 'pending').length,
    failedAccounts: rows.filter((row) => row.quotaSource === 'failed').length,
    priorityAccounts,
  };
}

function isSameResetCycle(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return true;
  return Math.abs(left - right) <= RESET_MATCH_TOLERANCE_MS;
}

function windowFromRow(
  row: DbRow,
  prefix: 'five_hour' | 'weekly',
  windowId: 'five-hour' | 'weekly',
  pricingProfile: PricingProfile,
  normalizedPlan: AccountQuotaRow['normalizedPlan'],
) {
  const usedPercent = asNumber(row[`${prefix}_used_percent`]);
  const remainingPoints = asNumber(row[`${prefix}_remaining_points`]);
  const resetAtMs = asNumber(row[`${prefix}_reset_at`]);
  const remainingUsd = calculateWindowUsd(pricingProfile, normalizedPlan, windowId, remainingPoints);
  if (usedPercent === null && remainingPoints === null && resetAtMs === null) return null;
  return {
    id: windowId,
    usedPercent,
    remainingPoints,
    remainingUsd,
    resetAtMs,
    priced: remainingUsd !== null,
  };
}

export class QuotaMonitorDb {
  private db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
    this.ensureDefaultPricingProfile();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pricing_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_label TEXT NOT NULL,
        profile_json TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cpa_id TEXT NOT NULL,
        cpa_name TEXT NOT NULL,
        cpa_api_base TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        total_accounts INTEGER NOT NULL,
        enabled_accounts INTEGER NOT NULL,
        paused_accounts INTEGER NOT NULL,
        failed_or_unknown_accounts INTEGER NOT NULL,
        successful_accounts INTEGER NOT NULL,
        five_hour_remaining_points REAL NOT NULL,
        weekly_remaining_points REAL NOT NULL,
        five_hour_remaining_usd REAL NOT NULL,
        weekly_remaining_usd REAL NOT NULL,
        unpriced_five_hour_accounts INTEGER NOT NULL,
        unpriced_weekly_accounts INTEGER NOT NULL,
        collect_strategy TEXT NOT NULL DEFAULT 'adaptive',
        fresh_accounts INTEGER NOT NULL DEFAULT 0,
        cached_accounts INTEGER NOT NULL DEFAULT 0,
        backoff_accounts INTEGER NOT NULL DEFAULT 0,
        pending_accounts INTEGER NOT NULL DEFAULT 0,
        failed_accounts INTEGER NOT NULL DEFAULT 0,
        priority_accounts INTEGER NOT NULL DEFAULT 0,
        error_summary TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_cpa_time ON snapshots (cpa_id, captured_at DESC);

      CREATE TABLE IF NOT EXISTS account_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        cpa_id TEXT NOT NULL,
        cpa_name TEXT NOT NULL,
        captured_at INTEGER NOT NULL,
        account_key TEXT,
        account_name TEXT NOT NULL,
        account_id TEXT,
        auth_index TEXT,
        status TEXT NOT NULL,
        disabled INTEGER NOT NULL,
        plan_type TEXT,
        normalized_plan TEXT NOT NULL,
        five_hour_used_percent REAL,
        five_hour_remaining_points REAL,
        five_hour_remaining_usd REAL,
        five_hour_reset_at INTEGER,
        weekly_used_percent REAL,
        weekly_remaining_points REAL,
        weekly_remaining_usd REAL,
        weekly_reset_at INTEGER,
        quota_source TEXT NOT NULL DEFAULT 'fresh',
        quota_sampled_at INTEGER,
        backoff_until INTEGER,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_account_samples_cpa_time ON account_samples (cpa_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS idx_account_samples_account_time ON account_samples (cpa_id, account_name, captured_at);
      CREATE INDEX IF NOT EXISTS idx_account_samples_account_key_time ON account_samples (cpa_id, account_key, quota_sampled_at);

      CREATE TABLE IF NOT EXISTS collector_state (
        cpa_id TEXT PRIMARY KEY,
        cpa_name TEXT NOT NULL,
        status TEXT NOT NULL,
        last_started_at INTEGER,
        last_completed_at INTEGER,
        last_error TEXT,
        next_run_at INTEGER,
        progress_completed_accounts INTEGER,
        progress_total_accounts INTEGER
      );

      CREATE TABLE IF NOT EXISTS account_collect_state (
        cpa_id TEXT NOT NULL,
        account_key TEXT NOT NULL,
        account_name TEXT NOT NULL,
        auth_index TEXT,
        last_quota_sampled_at INTEGER,
        last_success_at INTEGER,
        next_due_at INTEGER,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        quota_source TEXT NOT NULL,
        backoff_until INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (cpa_id, account_key)
      );
    `);
    this.ensureColumn('account_samples', 'five_hour_remaining_usd', 'REAL');
    this.ensureColumn('account_samples', 'weekly_remaining_usd', 'REAL');
    this.ensureColumn('account_samples', 'account_key', 'TEXT');
    this.ensureColumn('account_samples', 'quota_source', "TEXT NOT NULL DEFAULT 'fresh'");
    this.ensureColumn('account_samples', 'quota_sampled_at', 'INTEGER');
    this.ensureColumn('account_samples', 'backoff_until', 'INTEGER');
    this.ensureColumn('snapshots', 'collect_strategy', "TEXT NOT NULL DEFAULT 'adaptive'");
    this.ensureColumn('snapshots', 'fresh_accounts', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('snapshots', 'cached_accounts', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('snapshots', 'backoff_accounts', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('snapshots', 'pending_accounts', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('snapshots', 'failed_accounts', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('snapshots', 'priority_accounts', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('collector_state', 'progress_completed_accounts', 'INTEGER');
    this.ensureColumn('collector_state', 'progress_total_accounts', 'INTEGER');
    this.ensureColumn('account_collect_state', 'next_due_at', 'INTEGER');
    this.ensureColumn('account_collect_state', 'failure_count', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('account_collect_state', 'last_error', 'TEXT');
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private ensureDefaultPricingProfile(): void {
    const existing = this.db.query('SELECT id FROM pricing_profiles WHERE is_active = 1 LIMIT 1').get();
    if (existing) return;

    const profile = normalizePricingProfile({
      ...DEFAULT_PRICING_PROFILE,
      updatedAt: Date.now(),
    });
    this.db
      .query(
        `INSERT OR REPLACE INTO pricing_profiles
          (id, name, source_label, profile_json, is_active, updated_at)
         VALUES ($id, $name, $sourceLabel, $profileJson, 1, $updatedAt)`,
      )
      .run({
        $id: profile.id,
        $name: profile.name,
        $sourceLabel: profile.sourceLabel,
        $profileJson: jsonStringify(profile),
        $updatedAt: profile.updatedAt,
      });
  }

  getPricingProfile(): PricingProfile {
    const row = this.db
      .query('SELECT profile_json FROM pricing_profiles WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1')
      .get() as DbRow | null;
    return parsePricingRow(row);
  }

  savePricingProfile(input: PricingProfile): PricingProfile {
    const profile = normalizePricingProfile({ ...input, updatedAt: Date.now() });
    const tx = this.db.transaction(() => {
      this.db.query('UPDATE pricing_profiles SET is_active = 0').run();
      this.db
        .query(
          `INSERT OR REPLACE INTO pricing_profiles
            (id, name, source_label, profile_json, is_active, updated_at)
           VALUES ($id, $name, $sourceLabel, $profileJson, 1, $updatedAt)`,
        )
        .run({
          $id: profile.id,
          $name: profile.name,
          $sourceLabel: profile.sourceLabel,
          $profileJson: jsonStringify(profile),
          $updatedAt: profile.updatedAt,
        });
    });
    tx();
    return profile;
  }

  updateCollectorState(target: CpaTarget, state: Partial<CollectorState>): void {
    const current = this.getCollectorState(target);
    const next = { ...current, ...state };
    this.db
      .query(
        `INSERT OR REPLACE INTO collector_state
          (cpa_id, cpa_name, status, last_started_at, last_completed_at, last_error, next_run_at,
           progress_completed_accounts, progress_total_accounts)
         VALUES ($cpaId, $cpaName, $status, $lastStartedAt, $lastCompletedAt, $lastError, $nextRunAt,
           $progressCompletedAccounts, $progressTotalAccounts)`,
      )
      .run({
        $cpaId: target.id,
        $cpaName: target.name,
        $status: next.status,
        $lastStartedAt: next.lastStartedAt,
        $lastCompletedAt: next.lastCompletedAt,
        $lastError: next.lastError,
        $nextRunAt: next.nextRunAt,
        $progressCompletedAccounts: next.progressCompletedAccounts,
        $progressTotalAccounts: next.progressTotalAccounts,
      });
  }

  getCollectorState(target: CpaTarget): CollectorState {
    const row = this.db
      .query('SELECT * FROM collector_state WHERE cpa_id = $cpaId')
      .get({ $cpaId: target.id }) as DbRow | null;
    if (!row) return makeEmptyCollectorState();
    return {
      status: String(row.status) as CollectorState['status'],
      lastStartedAt: asNumber(row.last_started_at),
      lastCompletedAt: asNumber(row.last_completed_at),
      lastError: asString(row.last_error),
      nextRunAt: asNumber(row.next_run_at),
      progressCompletedAccounts: asNumber(row.progress_completed_accounts),
      progressTotalAccounts: asNumber(row.progress_total_accounts),
    };
  }

  saveSnapshot(
    target: CpaTargetConfig,
    capturedAt: number,
    rows: AccountQuotaRow[],
    strategy: CollectionRunSummary['strategy'],
    errorSummary: string | null,
    priorityAccounts = 0,
  ): number {
    const stats = buildMonitorStats(rows);
    const collection = buildCollectionSummary(rows, strategy, priorityAccounts);
    const tx = this.db.transaction(() => {
      const result = this.db
        .query(
          `INSERT INTO snapshots
            (cpa_id, cpa_name, cpa_api_base, captured_at, total_accounts, enabled_accounts, paused_accounts,
             failed_or_unknown_accounts, successful_accounts, five_hour_remaining_points, weekly_remaining_points,
             five_hour_remaining_usd, weekly_remaining_usd, unpriced_five_hour_accounts, unpriced_weekly_accounts,
             collect_strategy, fresh_accounts, cached_accounts, backoff_accounts, pending_accounts, failed_accounts,
             priority_accounts, error_summary)
           VALUES
            ($cpaId, $cpaName, $cpaApiBase, $capturedAt, $totalAccounts, $enabledAccounts, $pausedAccounts,
             $failedOrUnknownAccounts, $successfulAccounts, $fiveHourRemainingPoints, $weeklyRemainingPoints,
             $fiveHourRemainingUsd, $weeklyRemainingUsd, $unpricedFiveHourAccounts, $unpricedWeeklyAccounts,
             $collectStrategy, $freshAccounts, $cachedAccounts, $backoffAccounts, $pendingAccounts, $failedAccounts,
             $priorityAccounts, $errorSummary)`,
        )
        .run({
          $cpaId: target.id,
          $cpaName: target.name,
          $cpaApiBase: target.apiBase,
          $capturedAt: capturedAt,
          $totalAccounts: stats.totalAccounts,
          $enabledAccounts: stats.enabledAccounts,
          $pausedAccounts: stats.pausedAccounts,
          $failedOrUnknownAccounts: stats.failedOrUnknownAccounts,
          $successfulAccounts: stats.successfulAccounts,
          $fiveHourRemainingPoints: stats.fiveHourRemainingPoints,
          $weeklyRemainingPoints: stats.weeklyRemainingPoints,
          $fiveHourRemainingUsd: stats.fiveHourRemainingUsd,
          $weeklyRemainingUsd: stats.weeklyRemainingUsd,
          $unpricedFiveHourAccounts: stats.unpricedFiveHourAccounts,
          $unpricedWeeklyAccounts: stats.unpricedWeeklyAccounts,
          $collectStrategy: collection.strategy,
          $freshAccounts: collection.freshAccounts,
          $cachedAccounts: collection.cachedAccounts,
          $backoffAccounts: collection.backoffAccounts,
          $pendingAccounts: collection.pendingAccounts,
          $failedAccounts: collection.failedAccounts,
          $priorityAccounts: collection.priorityAccounts,
          $errorSummary: errorSummary,
        });
      const snapshotId = Number(result.lastInsertRowid);
      const insertAccount = this.db.query(
        `INSERT INTO account_samples
          (snapshot_id, cpa_id, cpa_name, captured_at, account_key, account_name, account_id, auth_index, status, disabled,
           plan_type, normalized_plan, five_hour_used_percent, five_hour_remaining_points, five_hour_remaining_usd,
           five_hour_reset_at, weekly_used_percent, weekly_remaining_points, weekly_remaining_usd, weekly_reset_at,
           quota_source, quota_sampled_at, backoff_until, error)
         VALUES
          ($snapshotId, $cpaId, $cpaName, $capturedAt, $accountKey, $accountName, $accountId, $authIndex, $status, $disabled,
           $planType, $normalizedPlan, $fiveHourUsedPercent, $fiveHourRemainingPoints, $fiveHourRemainingUsd,
           $fiveHourResetAt, $weeklyUsedPercent, $weeklyRemainingPoints, $weeklyRemainingUsd, $weeklyResetAt,
           $quotaSource, $quotaSampledAt, $backoffUntil, $error)`,
      );
      const upsertAccountState = this.db.query(
        `INSERT INTO account_collect_state
          (cpa_id, account_key, account_name, auth_index, last_quota_sampled_at, last_success_at,
           next_due_at, failure_count, last_error, quota_source, backoff_until, updated_at)
         VALUES
          ($cpaId, $accountKey, $accountName, $authIndex, $lastQuotaSampledAt, $lastSuccessAt,
           $nextDueAt, $failureCount, $lastError, $quotaSource, $backoffUntil, $updatedAt)
         ON CONFLICT(cpa_id, account_key) DO UPDATE SET
           account_name = excluded.account_name,
           auth_index = excluded.auth_index,
           last_quota_sampled_at = COALESCE(excluded.last_quota_sampled_at, account_collect_state.last_quota_sampled_at),
           last_success_at = COALESCE(excluded.last_success_at, account_collect_state.last_success_at),
           next_due_at = COALESCE(excluded.next_due_at, account_collect_state.next_due_at),
           failure_count = CASE
             WHEN excluded.quota_source = 'fresh' THEN 0
             WHEN excluded.failure_count > 0 THEN account_collect_state.failure_count + excluded.failure_count
             ELSE account_collect_state.failure_count
           END,
           last_error = CASE
             WHEN excluded.quota_source = 'fresh' THEN NULL
             ELSE COALESCE(excluded.last_error, account_collect_state.last_error)
           END,
           quota_source = excluded.quota_source,
           backoff_until = excluded.backoff_until,
           updated_at = excluded.updated_at`,
      );

      rows.forEach((row) => {
        const accountKey = getAccountKeyFromQuotaRow(row);
        const rowState = row as AccountQuotaRow & {
          collectNextDueAt?: number | null;
          collectAttemptedFailure?: boolean;
        };
        insertAccount.run({
          $snapshotId: snapshotId,
          $cpaId: target.id,
          $cpaName: target.name,
          $capturedAt: capturedAt,
          $accountKey: accountKey,
          $accountName: row.name,
          $accountId: row.accountId,
          $authIndex: row.authIndex,
          $status: row.status,
          $disabled: row.disabled ? 1 : 0,
          $planType: row.planType,
          $normalizedPlan: row.normalizedPlan,
          $fiveHourUsedPercent: row.fiveHour?.usedPercent ?? null,
          $fiveHourRemainingPoints: row.fiveHour?.remainingPoints ?? null,
          $fiveHourRemainingUsd: row.fiveHour?.remainingUsd ?? null,
          $fiveHourResetAt: row.fiveHour?.resetAtMs ?? null,
          $weeklyUsedPercent: row.weekly?.usedPercent ?? null,
          $weeklyRemainingPoints: row.weekly?.remainingPoints ?? null,
          $weeklyRemainingUsd: row.weekly?.remainingUsd ?? null,
          $weeklyResetAt: row.weekly?.resetAtMs ?? null,
          $quotaSource: row.quotaSource,
          $quotaSampledAt: row.quotaSampledAt,
          $backoffUntil: row.backoffUntil,
          $error: row.error,
        });
        upsertAccountState.run({
          $cpaId: target.id,
          $accountKey: accountKey,
          $accountName: row.name,
          $authIndex: row.authIndex,
          $lastQuotaSampledAt:
            row.quotaSource === 'fresh' || row.quotaSource === 'failed' || row.quotaSource === 'backoff'
              ? row.quotaSampledAt
              : null,
          $lastSuccessAt: row.quotaSource === 'fresh' && row.status === 'active' ? row.quotaSampledAt : null,
          $nextDueAt: rowState.collectNextDueAt ?? null,
          $failureCount: rowState.collectAttemptedFailure === true ? 1 : 0,
          $lastError: row.error,
          $quotaSource: row.quotaSource,
          $backoffUntil: row.backoffUntil,
          $updatedAt: capturedAt,
        });
      });
      return snapshotId;
    });
    return tx() as number;
  }

  pruneHistory(nowMs: number): void {
    const cutoff = nowMs - RETENTION_MS;
    this.db.query('DELETE FROM snapshots WHERE captured_at < $cutoff').run({ $cutoff: cutoff });
  }

  clearHistory(cpaId?: string): void {
    if (cpaId) {
      this.db.query('DELETE FROM snapshots WHERE cpa_id = $cpaId').run({ $cpaId: cpaId });
      this.db.query('DELETE FROM account_collect_state WHERE cpa_id = $cpaId').run({ $cpaId: cpaId });
    } else {
      this.db.query('DELETE FROM snapshots').run();
      this.db.query('DELETE FROM account_collect_state').run();
    }
  }

  getAccountCollectStates(cpaId: string): Map<string, AccountCollectState> {
    const rows = this.db
      .query('SELECT * FROM account_collect_state WHERE cpa_id = $cpaId')
      .all({ $cpaId: cpaId }) as DbRow[];
    return new Map(
      rows.map((row) => [
        String(row.account_key),
        {
          accountKey: String(row.account_key),
          accountName: String(row.account_name),
          authIndex: asString(row.auth_index),
          lastQuotaSampledAt: asNumber(row.last_quota_sampled_at),
          lastSuccessAt: asNumber(row.last_success_at),
          nextDueAt: asNumber(row.next_due_at),
          failureCount: asNumber(row.failure_count) ?? 0,
          lastError: asString(row.last_error),
          quotaSource: normalizeQuotaSource(row.quota_source),
          backoffUntil: asNumber(row.backoff_until),
        },
      ]),
    );
  }

  getLatestReusableAccounts(cpaId: string, pricingProfile: PricingProfile): Map<string, AccountQuotaRow> {
    const rows = this.db
      .query(
        `SELECT *
         FROM account_samples
         WHERE id IN (
           SELECT MAX(id)
           FROM account_samples
           WHERE cpa_id = $cpaId
             AND status = 'active'
             AND (five_hour_used_percent IS NOT NULL OR weekly_used_percent IS NOT NULL)
           GROUP BY COALESCE(account_key, auth_index, account_name)
         )`,
      )
      .all({ $cpaId: cpaId }) as DbRow[];
    return new Map(this.rowsToAccountQuotaRows(rows, pricingProfile).map((row) => [row.accountKey, row]));
  }

  getRecentlyConsumedAccountKeys(cpaId: string, nowMs: number, minutes = 60): Set<string> {
    const cutoff = nowMs - minutes * 60 * 1000;
    const historyCutoff = cutoff - minutes * 60 * 1000;
    const rows = this.db
      .query(
        `SELECT account_key, auth_index, account_name, COALESCE(quota_sampled_at, captured_at) AS sample_at,
                five_hour_used_percent, five_hour_reset_at
         FROM account_samples
         WHERE cpa_id = $cpaId
           AND COALESCE(quota_sampled_at, captured_at) >= $historyCutoff
           AND COALESCE(quota_sampled_at, captured_at) <= $nowMs
           AND status = 'active'
           AND quota_source = 'fresh'
         ORDER BY account_key ASC, sample_at ASC`,
      )
      .all({ $cpaId: cpaId, $historyCutoff: historyCutoff, $nowMs: nowMs }) as DbRow[];
    const series = new Map<string, DbRow[]>();
    rows.forEach((row) => {
      const usedPercent = asNumber(row.five_hour_used_percent);
      if (usedPercent === null) return;
      const accountKey = getAccountKeyFromRow(row);
      const entries = series.get(accountKey) ?? [];
      entries.push(row);
      series.set(accountKey, entries);
    });

    const consumed = new Set<string>();
    series.forEach((entries, accountKey) => {
      let previous: DbRow | null = null;
      for (const current of entries) {
        if (!previous) {
          previous = current;
          continue;
        }
        const previousUsed = asNumber(previous.five_hour_used_percent);
        const currentUsed = asNumber(current.five_hour_used_percent);
        if (
          previousUsed !== null &&
          currentUsed !== null &&
          isSameResetCycle(asNumber(previous.five_hour_reset_at), asNumber(current.five_hour_reset_at)) &&
          Number(current.sample_at) >= cutoff &&
          currentUsed > previousUsed
        ) {
          consumed.add(accountKey);
          return;
        }
        previous = current;
      }
    });
    return consumed;
  }

  getLatestPayload(targets: CpaTarget[], selectedCpaId: string, riskOptions: RiskOptions): LatestPayload {
    const target = targets.find((item) => item.id === selectedCpaId) ?? targets[0];
    const pricingProfile = this.getPricingProfile();
    const snapshotRow = this.db
      .query('SELECT * FROM snapshots WHERE cpa_id = $cpaId ORDER BY captured_at DESC, id DESC LIMIT 1')
      .get({ $cpaId: target.id }) as DbRow | null;
    const accounts = snapshotRow ? this.getAccountsForSnapshot(Number(snapshotRow.id), pricingProfile) : [];
    const nowMs = asNumber(snapshotRow?.captured_at) ?? Date.now();
    const historySamples = this.getHistoricalSamples(target.id, pricingProfile, nowMs);
    const enabledAccountCount = accounts.filter((row) => !row.disabled).length;
    const consumption = buildConsumptionSummary(historySamples, nowMs, enabledAccountCount);
    const accountsWithConsumption = applyRecentConsumption(accounts, consumption.byAccount30m);
    const stats = buildMonitorStats(accountsWithConsumption);
    const risk = buildRiskSummary(accountsWithConsumption, stats, consumption, Date.now(), riskOptions);
    const snapshot: SnapshotSummary | null = snapshotRow
      ? {
          id: Number(snapshotRow.id),
          cpaId: target.id,
          cpaName: target.name,
          capturedAt: Number(snapshotRow.captured_at),
          stats,
          collection: {
            strategy:
              String(snapshotRow.collect_strategy ?? 'adaptive') === 'full'
                ? 'full'
                : String(snapshotRow.collect_strategy ?? 'adaptive') === 'continuous'
                  ? 'continuous'
                  : 'adaptive',
            enabledAccounts: Number(snapshotRow.enabled_accounts ?? stats.enabledAccounts),
            freshAccounts: Number(snapshotRow.fresh_accounts ?? 0),
            cachedAccounts: Number(snapshotRow.cached_accounts ?? 0),
            backoffAccounts: Number(snapshotRow.backoff_accounts ?? 0),
            pendingAccounts: Number(snapshotRow.pending_accounts ?? 0),
            failedAccounts: Number(snapshotRow.failed_accounts ?? 0),
            priorityAccounts: Number(snapshotRow.priority_accounts ?? 0),
          },
          errorSummary: asString(snapshotRow.error_summary),
        }
      : null;

    return {
      targets,
      selectedCpaId: target.id,
      snapshot,
      accounts: accountsWithConsumption,
      refreshBuckets: buildRefreshBuckets(accountsWithConsumption),
      consumption,
      prediction: buildPrediction(stats, consumption),
      risk,
      pricingProfile,
      collectorState: this.getCollectorState(target),
    };
  }

  private getAccountsForSnapshot(snapshotId: number, pricingProfile: PricingProfile): AccountQuotaRow[] {
    const rows = this.db
      .query('SELECT * FROM account_samples WHERE snapshot_id = $snapshotId ORDER BY account_name ASC')
      .all({ $snapshotId: snapshotId }) as DbRow[];

    return this.rowsToAccountQuotaRows(rows, pricingProfile);
  }

  private rowsToAccountQuotaRows(rows: DbRow[], pricingProfile: PricingProfile): AccountQuotaRow[] {
    return rows.map((row) => {
      const normalizedPlan = String(row.normalized_plan) as AccountQuotaRow['normalizedPlan'];
      const quotaSampledAt = asNumber(row.quota_sampled_at);
      return {
        cpaId: String(row.cpa_id),
        cpaName: String(row.cpa_name),
        accountKey: getAccountKeyFromRow(row),
        name: String(row.account_name),
        provider: 'codex',
        authIndex: asString(row.auth_index),
        accountId: asString(row.account_id),
        disabled: asBoolean(row.disabled),
        status: String(row.status) as AccountQuotaRow['status'],
        planType: asString(row.plan_type),
        normalizedPlan,
        fiveHour: windowFromRow(row, 'five_hour', 'five-hour', pricingProfile, normalizedPlan),
        weekly: windowFromRow(row, 'weekly', 'weekly', pricingProfile, normalizedPlan),
        recent30mConsumedUsd: null,
        recent30mConsumptionState: 'no-sample',
        quotaSource: normalizeQuotaSource(row.quota_source),
        quotaSampledAt,
        quotaAgeMs: quotaSampledAt !== null ? Math.max(0, Date.now() - quotaSampledAt) : null,
        backoffUntil: asNumber(row.backoff_until),
        error: asString(row.error),
      };
    });
  }

  private getHistoricalSamples(cpaId: string, pricingProfile: PricingProfile, nowMs: number) {
    const cutoff = nowMs - 5 * 60 * 60 * 1000;
    const rows = this.db
      .query(
        `SELECT cpa_id, account_key, auth_index, account_name, normalized_plan,
                COALESCE(quota_sampled_at, captured_at) AS sample_at, five_hour_used_percent,
                five_hour_reset_at
         FROM account_samples
         WHERE cpa_id = $cpaId
           AND COALESCE(quota_sampled_at, captured_at) >= $cutoff
           AND COALESCE(quota_sampled_at, captured_at) <= $nowMs
           AND status = 'active'
           AND quota_source = 'fresh'
         ORDER BY sample_at ASC`,
      )
      .all({ $cpaId: cpaId, $cutoff: cutoff, $nowMs: nowMs }) as DbRow[];

    return rows.map((row) => {
      const normalizedPlan = String(row.normalized_plan) as AccountQuotaRow['normalizedPlan'];
      const fullUsd = calculateWindowUsd(pricingProfile, normalizedPlan, 'five-hour', 100);
      return {
        cpaId: String(row.cpa_id),
        accountKey: getAccountKeyFromRow(row),
        name: String(row.account_name),
        normalizedPlan,
        capturedAt: Number(row.sample_at),
        usedPercent: asNumber(row.five_hour_used_percent),
        resetAtMs: asNumber(row.five_hour_reset_at),
        consumedUsdPerPoint: typeof fullUsd === 'number' ? fullUsd / 100 : null,
      };
    });
  }
}
