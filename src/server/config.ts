import type { CpaTarget } from '../shared/domain';
import type { RiskOptions, RiskTone } from '../shared/domain';
import { normalizeApiBase } from './http';

export interface CpaTargetConfig extends CpaTarget {
  managementKey: string;
}

export interface AliyunSmsConfig {
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  templateCode: string;
  templateParamName: string;
  regionId: string;
  endpoint: string;
}

export interface SmsAlertConfig {
  enabled: boolean;
  provider: 'webhook' | 'aliyun';
  webhookUrl: string;
  webhookToken: string;
  aliyun: AliyunSmsConfig;
  recipients: string[];
  minTone: Exclude<RiskTone, 'ok' | 'muted'>;
  cooldownMinutes: number;
  timeoutSeconds: number;
  accountIssueThreshold: number;
  maxMessageChars: number;
}

export interface ServerConfig {
  port: number;
  dbPath: string;
  monitorKey: string;
  collectIntervalMinutes: number;
  collectStrategy: 'adaptive' | 'continuous' | 'full';
  collectSamplePercent: number;
  collectMaxStaleMinutes: number;
  collectNewAccountBurst: number;
  collectConcurrency: number;
  collectJitterSeconds: number;
  collectConsumptionSamplePercent: number;
  collectConsumptionWindowMinutes: number;
  collectUsageMaxRequestsPerMinute: number;
  collectUsageNormalMinIntervalMinutes: number;
  collectUsageHotMinIntervalMinutes: number;
  collectUsageMaxStalenessMinutes: number;
  collectUsageTickSeconds: number;
  collectManualConcurrency: number;
  collectManualMaxRequestsPerMinute: number;
  collectUsageErrorBackoffMinutes: number;
  collectUsageErrorBackoffMaxMinutes: number;
  accountBackoffMinutes: number;
  cpaRequestTimeoutSeconds: number;
  cacheTrustMaxMinutes: number;
  alertWarnAvailableHours: number;
  alertCriticalAvailableHours: number;
  alertEmergencyAvailableHours: number;
  smsAlert: SmsAlertConfig;
  cookieSecure: boolean;
  targets: CpaTargetConfig[];
}

function readEnv(name: string): string {
  return Bun.env[name]?.trim() ?? '';
}

function normalizeTargetId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function parseNumberEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeNumberEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseStrategyEnv(): ServerConfig['collectStrategy'] {
  const raw = (readEnv('COLLECT_USAGE_MODE') || readEnv('COLLECT_STRATEGY')).toLowerCase();
  if (raw === 'full') return 'full';
  if (raw === 'adaptive') return 'adaptive';
  return 'continuous';
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = readEnv(name).toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

function parseCsvEnv(name: string): string[] {
  return readEnv(name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAlertToneEnv(): SmsAlertConfig['minTone'] {
  const raw = readEnv('ALERT_SMS_MIN_TONE').toLowerCase();
  if (raw === 'critical') return 'critical';
  if (raw === 'watch') return 'watch';
  return 'warn';
}

function parseSmsProviderEnv(webhookUrl: string, aliyunConfigured: boolean): SmsAlertConfig['provider'] {
  const raw = readEnv('ALERT_SMS_PROVIDER').toLowerCase();
  if (raw === 'aliyun') return 'aliyun';
  if (raw === 'webhook') return 'webhook';
  return aliyunConfigured && !webhookUrl ? 'aliyun' : 'webhook';
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseTargetsFromJson(raw: string): CpaTargetConfig[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('CPA_TARGETS must be a JSON array');
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`CPA_TARGETS[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const apiBase = normalizeApiBase(String(record.apiBase ?? record.api_base ?? '').trim());
    const managementKey = String(record.managementKey ?? record.management_key ?? '').trim();
    if (!apiBase || !managementKey) {
      throw new Error(`CPA_TARGETS[${index}] requires apiBase and managementKey`);
    }

    const name = String(record.name ?? `CPA ${index + 1}`).trim() || `CPA ${index + 1}`;
    const id = normalizeTargetId(String(record.id ?? name)) || `cpa-${index + 1}`;
    return { id, name, apiBase, managementKey };
  });
}

function dedupeTargets(targets: CpaTargetConfig[]): CpaTargetConfig[] {
  const seen = new Set<string>();
  return targets.map((target, index) => {
    let id = target.id || `cpa-${index + 1}`;
    if (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    return { ...target, id };
  });
}

function readTargets(): CpaTargetConfig[] {
  const rawTargets = readEnv('CPA_TARGETS');
  if (rawTargets) return dedupeTargets(parseTargetsFromJson(rawTargets));

  const apiBase = normalizeApiBase(readEnv('CPA_API_BASE'));
  const managementKey = readEnv('CPA_MANAGEMENT_KEY');
  if (!apiBase || !managementKey) {
    throw new Error('Set CPA_TARGETS or both CPA_API_BASE and CPA_MANAGEMENT_KEY');
  }

  return [
    {
      id: normalizeTargetId(readEnv('CPA_ID') || 'default') || 'default',
      name: readEnv('CPA_NAME') || '默认 CPA',
      apiBase,
      managementKey,
    },
  ];
}

function readSmsAlertConfig(): SmsAlertConfig {
  const webhookUrl = readEnv('ALERT_SMS_WEBHOOK_URL') || readEnv('ALERT_WEBHOOK_URL');
  const webhookToken = readEnv('ALERT_SMS_WEBHOOK_TOKEN') || readEnv('ALERT_WEBHOOK_TOKEN');
  const aliyun: AliyunSmsConfig = {
    accessKeyId: readEnv('ALIYUN_SMS_ACCESS_KEY_ID') || readEnv('ALIBABACLOUD_ACCESS_KEY_ID'),
    accessKeySecret: readEnv('ALIYUN_SMS_ACCESS_KEY_SECRET') || readEnv('ALIBABACLOUD_ACCESS_KEY_SECRET'),
    signName: readEnv('ALIYUN_SMS_SIGN_NAME'),
    templateCode: readEnv('ALIYUN_SMS_TEMPLATE_CODE'),
    templateParamName: readEnv('ALIYUN_SMS_TEMPLATE_PARAM_NAME') || 'content',
    regionId: readEnv('ALIYUN_SMS_REGION_ID') || 'cn-hangzhou',
    endpoint: readEnv('ALIYUN_SMS_ENDPOINT') || 'https://dysmsapi.aliyuncs.com',
  };
  const aliyunConfigured = Boolean(
    aliyun.accessKeyId && aliyun.accessKeySecret && aliyun.signName && aliyun.templateCode,
  );
  const provider = parseSmsProviderEnv(webhookUrl, aliyunConfigured);
  return {
    enabled: parseBooleanEnv('ALERT_SMS_ENABLED', Boolean(webhookUrl || aliyunConfigured)),
    provider,
    webhookUrl,
    webhookToken,
    aliyun,
    recipients: parseCsvEnv('ALERT_SMS_RECIPIENTS'),
    minTone: parseAlertToneEnv(),
    cooldownMinutes: parseNumberEnv('ALERT_SMS_COOLDOWN_MINUTES', 30),
    timeoutSeconds: parseNumberEnv('ALERT_SMS_TIMEOUT_SECONDS', 10),
    accountIssueThreshold: Math.max(1, Math.floor(parseNumberEnv('ALERT_ACCOUNT_ISSUE_THRESHOLD', 1))),
    maxMessageChars: Math.max(80, Math.floor(parseNumberEnv('ALERT_SMS_MAX_MESSAGE_CHARS', 500))),
  };
}

export function getRiskOptions(config: ServerConfig): RiskOptions {
  return {
    cacheTrustMaxMinutes: config.cacheTrustMaxMinutes,
    warnAvailableHours: config.alertWarnAvailableHours,
    criticalAvailableHours: config.alertCriticalAvailableHours,
    emergencyAvailableHours: config.alertEmergencyAvailableHours,
    projectionHours: 5,
  };
}

export function loadConfig(): ServerConfig {
  const monitorKey = readEnv('MONITOR_KEY');
  if (!monitorKey) throw new Error('Set MONITOR_KEY');

  return {
    port: parseNumberEnv('PORT', 8787),
    dbPath: readEnv('DB_PATH') || './data/quota-monitor.sqlite',
    monitorKey,
    collectIntervalMinutes: parseNumberEnv('COLLECT_INTERVAL_MINUTES', 15),
    collectStrategy: parseStrategyEnv(),
    collectSamplePercent: clamp(parseNumberEnv('COLLECT_SAMPLE_PERCENT', 20), 1, 100),
    collectMaxStaleMinutes: parseNumberEnv('COLLECT_MAX_STALE_MINUTES', 120),
    collectNewAccountBurst: Math.floor(parseNonNegativeNumberEnv('COLLECT_NEW_ACCOUNT_BURST', 20)),
    collectConcurrency: Math.max(1, Math.floor(parseNumberEnv('COLLECT_CONCURRENCY', 2))),
    collectJitterSeconds: parseNonNegativeNumberEnv(
      'COLLECT_USAGE_JITTER_SECONDS',
      parseNonNegativeNumberEnv('COLLECT_JITTER_SECONDS', 45),
    ),
    collectConsumptionSamplePercent: clamp(parseNonNegativeNumberEnv('COLLECT_CONSUMPTION_SAMPLE_PERCENT', 60), 0, 100),
    collectConsumptionWindowMinutes: parseNumberEnv('COLLECT_CONSUMPTION_WINDOW_MINUTES', 30),
    collectUsageMaxRequestsPerMinute: parseNumberEnv('COLLECT_USAGE_MAX_REQUESTS_PER_MINUTE', 2),
    collectUsageNormalMinIntervalMinutes: parseNumberEnv('COLLECT_USAGE_NORMAL_MIN_INTERVAL_MINUTES', 90),
    collectUsageHotMinIntervalMinutes: parseNumberEnv('COLLECT_USAGE_HOT_MIN_INTERVAL_MINUTES', 30),
    collectUsageMaxStalenessMinutes: parseNumberEnv('COLLECT_USAGE_MAX_STALENESS_MINUTES', 120),
    collectUsageTickSeconds: parseNumberEnv('COLLECT_USAGE_TICK_SECONDS', 180),
    collectManualConcurrency: Math.max(1, Math.floor(parseNumberEnv('COLLECT_MANUAL_CONCURRENCY', 10))),
    collectManualMaxRequestsPerMinute: parseNumberEnv('COLLECT_MANUAL_MAX_REQUESTS_PER_MINUTE', 10),
    collectUsageErrorBackoffMinutes: parseNonNegativeNumberEnv('COLLECT_USAGE_ERROR_BACKOFF_MINUTES', 10),
    collectUsageErrorBackoffMaxMinutes: parseNonNegativeNumberEnv('COLLECT_USAGE_ERROR_BACKOFF_MAX_MINUTES', 120),
    accountBackoffMinutes: parseNonNegativeNumberEnv('ACCOUNT_BACKOFF_MINUTES', 10),
    cpaRequestTimeoutSeconds: parseNumberEnv('CPA_REQUEST_TIMEOUT_SECONDS', 60),
    cacheTrustMaxMinutes: parseNumberEnv('CACHE_TRUST_MAX_MINUTES', 60),
    alertWarnAvailableHours: parseNumberEnv(
      'ALERT_POOL_REMAINING_HOURS_WARN',
      parseNumberEnv('ALERT_WARN_AVAILABLE_HOURS', 6),
    ),
    alertCriticalAvailableHours: parseNumberEnv(
      'ALERT_POOL_REMAINING_HOURS_CRITICAL',
      parseNumberEnv('ALERT_CRITICAL_AVAILABLE_HOURS', 3),
    ),
    alertEmergencyAvailableHours: parseNumberEnv('ALERT_POOL_REMAINING_HOURS_EMERGENCY', 1),
    smsAlert: readSmsAlertConfig(),
    cookieSecure: readEnv('COOKIE_SECURE') === 'true',
    targets: readTargets(),
  };
}
