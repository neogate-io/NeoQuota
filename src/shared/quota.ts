import type {
  AccountQuotaRow,
  AuthFileItem,
  PlanKey,
  PricingProfile,
  QuotaWindowState,
} from './domain';
import { calculateWindowUsd, normalizePlanKey } from './pricing';

const FIVE_HOUR_SECONDS = 18_000;
const WEEK_SECONDS = 604_800;

interface CodexUsageWindow {
  used_percent?: unknown;
  usedPercent?: unknown;
  limit_window_seconds?: unknown;
  limitWindowSeconds?: unknown;
  reset_after_seconds?: unknown;
  resetAfterSeconds?: unknown;
  reset_at?: unknown;
  resetAt?: unknown;
}

interface CodexRateLimitInfo {
  allowed?: unknown;
  limit_reached?: unknown;
  limitReached?: unknown;
  primary_window?: CodexUsageWindow | null;
  primaryWindow?: CodexUsageWindow | null;
  secondary_window?: CodexUsageWindow | null;
  secondaryWindow?: CodexUsageWindow | null;
}

export interface CodexUsagePayload {
  plan_type?: unknown;
  planType?: unknown;
  rate_limit?: CodexRateLimitInfo | null;
  rateLimit?: CodexRateLimitInfo | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function normalizeStringValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString();
  return null;
}

function normalizeNumberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function resolveAuthProvider(file: AuthFileItem): string {
  const raw = file.provider ?? file.type ?? '';
  const key = String(raw).trim().toLowerCase().replace(/_/g, '-');
  if (key === 'x-ai' || key === 'grok') return 'xai';
  return key;
}

export function isCodexFile(file: AuthFileItem): boolean {
  return resolveAuthProvider(file) === 'codex';
}

export function isDisabledAuthFile(file: AuthFileItem): boolean {
  const raw = file.disabled;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

export function normalizeAuthIndex(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function decodeBase64UrlPayload(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return globalThis.atob(padded);
  } catch {
    return null;
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return asRecord(JSON.parse(trimmed) as unknown);
  } catch {
    return null;
  }
}

function parseIdTokenPayload(value: unknown): Record<string, unknown> | null {
  const json = parseJsonRecord(value);
  if (json) return json;
  if (typeof value !== 'string') return null;
  const segments = value.trim().split('.');
  if (segments.length < 2) return null;
  const decoded = decodeBase64UrlPayload(segments[1]);
  if (!decoded) return null;
  try {
    return asRecord(JSON.parse(decoded) as unknown);
  } catch {
    return null;
  }
}

function getNestedRecord(file: AuthFileItem, key: 'metadata' | 'attributes'): Record<string, unknown> | null {
  return asRecord(file[key]);
}

export function resolveCodexChatgptAccountId(file: AuthFileItem): string | null {
  const metadata = getNestedRecord(file, 'metadata');
  const attributes = getNestedRecord(file, 'attributes');

  for (const candidate of [file.id_token, metadata?.id_token, attributes?.id_token]) {
    const payload = parseIdTokenPayload(candidate);
    const accountId = normalizeStringValue(payload?.chatgpt_account_id ?? payload?.chatgptAccountId);
    if (accountId) return accountId;
  }

  return null;
}

function pushUnique(values: string[], value: string | null): void {
  if (value && !values.includes(value)) values.push(value);
}

export function resolveCodexAccountKeyCandidates(file: AuthFileItem): string[] {
  const candidates: string[] = [];
  pushUnique(candidates, resolveCodexChatgptAccountId(file));
  pushUnique(candidates, normalizeAuthIndex(file.auth_index ?? file.authIndex));
  pushUnique(candidates, file.name);
  return candidates;
}

export function resolveCodexAccountKey(file: AuthFileItem): string {
  return resolveCodexAccountKeyCandidates(file)[0] ?? file.name;
}

export function resolveCodexPlanType(
  file: AuthFileItem,
  payload?: CodexUsagePayload | null,
): string | null {
  const metadata = getNestedRecord(file, 'metadata');
  const attributes = getNestedRecord(file, 'attributes');
  const idPayloads = [file.id_token, metadata?.id_token, attributes?.id_token]
    .map(parseIdTokenPayload)
    .filter(Boolean) as Record<string, unknown>[];

  const candidates: unknown[] = [
    payload?.plan_type,
    payload?.planType,
    file.plan_type,
    file.planType,
    metadata?.plan_type,
    metadata?.planType,
    attributes?.plan_type,
    attributes?.planType,
  ];

  idPayloads.forEach((idPayload) => candidates.push(idPayload.plan_type, idPayload.planType));

  for (const candidate of candidates) {
    const planType = normalizeStringValue(candidate);
    if (planType) return planType.toLowerCase();
  }

  return null;
}

export function parseCodexUsagePayload(value: unknown): CodexUsagePayload | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed) as CodexUsagePayload;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') return value as CodexUsagePayload;
  return null;
}

function getWindowSeconds(window: CodexUsageWindow | null | undefined): number | null {
  if (!window) return null;
  return normalizeNumberValue(window.limit_window_seconds ?? window.limitWindowSeconds);
}

function parseResetAtMs(window: CodexUsageWindow, nowMs: number): number | null {
  const resetAtRaw = window.reset_at ?? window.resetAt;
  const numericResetAt = normalizeNumberValue(resetAtRaw);

  if (numericResetAt !== null) {
    return numericResetAt < 10_000_000_000 ? numericResetAt * 1000 : numericResetAt;
  }

  const resetAtText = normalizeStringValue(resetAtRaw);
  if (resetAtText) {
    const parsedDate = Date.parse(resetAtText);
    if (Number.isFinite(parsedDate)) return parsedDate;
  }

  const resetAfterSeconds = normalizeNumberValue(window.reset_after_seconds ?? window.resetAfterSeconds);
  if (resetAfterSeconds !== null) return nowMs + resetAfterSeconds * 1000;

  return null;
}

function pickMainWindows(rateLimit: CodexRateLimitInfo | null | undefined): {
  fiveHour: CodexUsageWindow | null;
  weekly: CodexUsageWindow | null;
} {
  const primary = rateLimit?.primary_window ?? rateLimit?.primaryWindow ?? null;
  const secondary = rateLimit?.secondary_window ?? rateLimit?.secondaryWindow ?? null;
  let fiveHour: CodexUsageWindow | null = null;
  let weekly: CodexUsageWindow | null = null;

  [primary, secondary].forEach((window) => {
    if (!window) return;
    const seconds = getWindowSeconds(window);
    if (seconds === FIVE_HOUR_SECONDS && !fiveHour) fiveHour = window;
    if (seconds === WEEK_SECONDS && !weekly) weekly = window;
  });

  if (!fiveHour && primary && primary !== weekly) fiveHour = primary;
  if (!weekly && secondary && secondary !== fiveHour) weekly = secondary;

  return { fiveHour, weekly };
}

function toQuotaWindow(
  pricingProfile: PricingProfile,
  planKey: PlanKey,
  id: QuotaWindowState['id'],
  window: CodexUsageWindow | null,
  nowMs: number,
  limitReached: boolean,
  allowed: unknown,
): QuotaWindowState | null {
  if (!window) return null;

  const resetAtMs = parseResetAtMs(window, nowMs);
  const rawUsedPercent = normalizeNumberValue(window.used_percent ?? window.usedPercent);
  const usedPercent =
    rawUsedPercent !== null
      ? clampPercent(rawUsedPercent)
      : (limitReached || allowed === false) && resetAtMs
        ? 100
        : null;
  const remainingPoints = usedPercent === null ? null : clampPercent(100 - usedPercent);
  const remainingUsd = calculateWindowUsd(pricingProfile, planKey, id, remainingPoints);

  return {
    id,
    usedPercent,
    remainingPoints,
    remainingUsd,
    resetAtMs,
    priced: remainingUsd !== null,
  };
}

export function buildCodexQuotaRow(
  cpaId: string,
  cpaName: string,
  file: AuthFileItem,
  payload: CodexUsagePayload | null,
  pricingProfile: PricingProfile,
  nowMs: number,
  error: string | null = null,
): AccountQuotaRow {
  const disabled = isDisabledAuthFile(file);
  const planType = resolveCodexPlanType(file, payload);
  const normalizedPlan = normalizePlanKey(planType);
  const accountId = resolveCodexChatgptAccountId(file);
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  const accountKey = resolveCodexAccountKey(file);

  if (disabled) {
    return {
      cpaId,
      cpaName,
      accountKey,
      name: file.name,
      provider: resolveAuthProvider(file),
      authIndex,
      accountId,
      disabled: true,
      status: 'paused',
      planType,
      normalizedPlan,
      fiveHour: null,
      weekly: null,
      recent30mConsumedUsd: null,
      recent30mConsumptionState: 'no-sample',
      quotaSource: 'paused',
      quotaSampledAt: null,
      quotaAgeMs: null,
      backoffUntil: null,
      error: null,
    };
  }

  if (!payload || error) {
    return {
      cpaId,
      cpaName,
      accountKey,
      name: file.name,
      provider: resolveAuthProvider(file),
      authIndex,
      accountId,
      disabled: false,
      status: 'failed',
      planType,
      normalizedPlan,
      fiveHour: null,
      weekly: null,
      recent30mConsumedUsd: null,
      recent30mConsumptionState: 'no-sample',
      quotaSource: 'failed',
      quotaSampledAt: nowMs,
      quotaAgeMs: 0,
      backoffUntil: null,
      error: error ?? 'usage 响应为空或不是有效 JSON',
    };
  }

  const rateLimit = payload.rate_limit ?? payload.rateLimit ?? null;
  const limitReached = Boolean(rateLimit?.limit_reached ?? rateLimit?.limitReached);
  const allowed = rateLimit?.allowed;
  const mainWindows = pickMainWindows(rateLimit);
  const fiveHour = toQuotaWindow(
    pricingProfile,
    normalizedPlan,
    'five-hour',
    mainWindows.fiveHour,
    nowMs,
    limitReached,
    allowed,
  );
  const weekly = toQuotaWindow(
    pricingProfile,
    normalizedPlan,
    'weekly',
    mainWindows.weekly,
    nowMs,
    limitReached,
    allowed,
  );

  const missing: string[] = [];
  if (!fiveHour || fiveHour.usedPercent === null) missing.push('5h');
  if (!weekly || weekly.usedPercent === null) missing.push('周');

  return {
    cpaId,
    cpaName,
    accountKey,
    name: file.name,
    provider: resolveAuthProvider(file),
    authIndex,
    accountId,
    disabled: false,
    status: missing.length > 0 ? 'unknown' : 'active',
    planType,
    normalizedPlan,
    fiveHour,
    weekly,
    recent30mConsumedUsd: null,
    recent30mConsumptionState: 'no-sample',
    quotaSource: missing.length > 0 ? 'failed' : 'fresh',
    quotaSampledAt: nowMs,
    quotaAgeMs: 0,
    backoffUntil: null,
    error: missing.length > 0 ? `缺少 ${missing.join('/')} 主窗口额度数据` : null,
  };
}
