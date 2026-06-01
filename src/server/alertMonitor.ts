import { createHmac, randomUUID } from 'node:crypto';
import type { AccountQuotaRow, LatestPayload, RiskTone } from '../shared/domain';
import { formatUsd } from '../shared/pricing';
import type { AliyunSmsConfig, CpaTargetConfig, ServerConfig, SmsAlertConfig } from './config';

type AlertSeverity = Exclude<RiskTone, 'ok' | 'muted'>;
type AlertKind = 'capacity' | 'account-issues';

interface AlertCandidate {
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  detail: string;
  message: string;
  fingerprint: string;
  count: number;
  issueAccounts: AccountQuotaRow[];
}

interface SentAlertState {
  sentAt: number;
  severity: AlertSeverity;
  fingerprint: string;
  count: number;
}

interface SmsWebhookPayload {
  type: 'quota_monitor_alert';
  channel: 'sms';
  severity: AlertSeverity;
  kind: AlertKind;
  cpaId: string;
  cpaName: string;
  recipients: string[];
  title: string;
  detail: string;
  message: string;
  snapshotId: number | null;
  capturedAt: number | null;
  metrics: {
    enabledAccounts: number | null;
    failedOrUnknownAccounts: number | null;
    hardIssueAccounts: number;
    conservativeFiveHourUsd: number;
    nominalFiveHourUsd: number;
    hourlyBurnUsd: number | null;
    oneHourBurnUsd: number | null;
    threeHourBurnUsd: number | null;
    thirtyMinuteBurnUsd: number | null;
    burnRateBasis: LatestPayload['risk']['burnRateBasis'];
    availableHours: number | null;
    estimatedDepletionAt: number | null;
    consumptionCoveragePercent: number;
    spikeDetected: boolean;
    trustedCoveragePercent: number;
    freshCoveragePercent: number;
  };
  issueAccounts: Array<{
    name: string;
    accountId: string | null;
    quotaSource: AccountQuotaRow['quotaSource'];
    status: AccountQuotaRow['status'];
    error: string | null;
  }>;
}

type AliyunSmsResponse = {
  Code?: string;
  Message?: string;
  RequestId?: string;
  [key: string]: unknown;
};

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  watch: 1,
  warn: 2,
  critical: 3,
};

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

function getToneLabel(severity: AlertSeverity): string {
  if (severity === 'critical') return '紧急';
  if (severity === 'warn') return '预警';
  return '观察';
}

function getBurnRateBasisLabel(value: LatestPayload['risk']['burnRateBasis']): string {
  if (value === 'three-hour') return '近3h均速';
  if (value === 'one-hour') return '近1h提速';
  if (value === 'thirty-minute-spike') return '近30m突增';
  if (value === 'zero') return '近期低消耗';
  return '样本不足';
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/\*/g, '%2A').replace(/%7E/g, '~');
}

function formatAliyunTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildAliyunSignedUrl(config: AliyunSmsConfig, params: Record<string, string>): string {
  const queryParams: Record<string, string> = {
    ...params,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: formatAliyunTimestamp(new Date()),
    Version: '2017-05-25',
  };
  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(queryParams[key])}`)
    .join('&');
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalQuery)}`;
  const signature = createHmac('sha1', `${config.accessKeySecret}&`).update(stringToSign).digest('base64');
  const signedQuery = `Signature=${percentEncode(signature)}&${canonicalQuery}`;
  const url = new URL(config.endpoint);
  url.search = signedQuery;
  return url.toString();
}

function getIssueReason(row: AccountQuotaRow): string {
  if (row.quotaSource === 'backoff') return '退避';
  if (row.quotaSource === 'failed') return '失败';
  if (row.status === 'failed') return '失败';
  if (row.status === 'unknown') return '未知';
  return row.quotaSource;
}

function isHardIssueRow(row: AccountQuotaRow): boolean {
  if (row.disabled) return false;
  if (row.quotaSource === 'backoff' || row.quotaSource === 'failed') return true;
  return row.status === 'failed' || (row.status === 'unknown' && row.quotaSource !== 'pending');
}

function getIssueFingerprint(rows: AccountQuotaRow[]): string {
  return rows
    .map((row) => `${row.accountKey}:${row.quotaSource}:${row.status}:${row.error ?? ''}`)
    .sort()
    .join('|');
}

function summarizeIssueAccounts(rows: AccountQuotaRow[], limit = 4): string {
  if (rows.length === 0) return '无硬异常账号';
  const preview = rows
    .slice(0, limit)
    .map((row) => `${row.name}(${getIssueReason(row)})`)
    .join('、');
  return rows.length > limit ? `${preview} 等 ${rows.length} 个` : preview;
}

function buildCapacityMessage(target: CpaTargetConfig, latest: LatestPayload): string {
  const risk = latest.risk;
  return [
    `[CPA${getToneLabel(risk.tone as AlertSeverity)}] ${target.name}：${risk.title}`,
    `可撑 ${formatHours(risk.availableHours)}`,
    `预计耗尽 ${formatDateTime(risk.estimatedDepletionAt)}`,
    `保守5h ${formatUsd(risk.conservativeFiveHourUsd)}`,
    `每小时 ${risk.hourlyBurnUsd === null ? '暂无样本' : formatUsd(risk.hourlyBurnUsd)}`,
    `口径 ${getBurnRateBasisLabel(risk.burnRateBasis)}`,
    `消耗覆盖 ${formatPercent(risk.consumptionCoveragePercent)}`,
  ].join('，');
}

function buildAccountIssueMessage(target: CpaTargetConfig, latest: LatestPayload, issueRows: AccountQuotaRow[]): string {
  return [
    `[CPA预警] ${target.name}：账号池使用异常`,
    `硬异常 ${issueRows.length} 个`,
    `失败/未知 ${latest.snapshot?.stats.failedOrUnknownAccounts ?? issueRows.length} 个`,
    `异常账号：${summarizeIssueAccounts(issueRows)}`,
  ].join('，');
}

export class AlertMonitor {
  private config: SmsAlertConfig;
  private sentAlerts = new Map<string, SentAlertState>();

  constructor(serverConfig: ServerConfig) {
    this.config = serverConfig.smsAlert;
    if (this.config.enabled && this.config.provider === 'webhook' && !this.config.webhookUrl) {
      console.warn('SMS alert enabled but ALERT_SMS_WEBHOOK_URL / ALERT_WEBHOOK_URL is not set; alerts will be skipped.');
    }
    if (this.config.enabled && this.config.provider === 'aliyun' && this.getMissingAliyunConfig().length > 0) {
      console.warn(`Aliyun SMS alert enabled but config is incomplete: ${this.getMissingAliyunConfig().join(', ')}`);
    }
  }

  async evaluateTarget(target: CpaTargetConfig, latest: LatestPayload): Promise<void> {
    if (!this.config.enabled) return;
    if (this.config.provider === 'webhook' && !this.config.webhookUrl) return;

    const candidates = this.buildCandidates(target, latest).filter((candidate) => this.shouldSend(candidate, target.id));
    for (const candidate of candidates) {
      await this.sendCandidate(target, latest, candidate);
    }
  }

  private buildCandidates(target: CpaTargetConfig, latest: LatestPayload): AlertCandidate[] {
    const candidates: AlertCandidate[] = [];
    const risk = latest.risk;
    if (risk.tone === 'critical' || risk.tone === 'warn' || risk.tone === 'watch') {
      const severity = risk.tone;
      if (SEVERITY_RANK[severity] >= SEVERITY_RANK[this.config.minTone]) {
        candidates.push({
          kind: 'capacity',
          severity,
          title: risk.title,
          detail: risk.detail,
          message: truncateText(buildCapacityMessage(target, latest), this.config.maxMessageChars),
          fingerprint: [
            severity,
            risk.title,
            Math.round(risk.conservativeFiveHourUsd),
            Math.round(risk.hourlyBurnUsd ?? -1),
            Math.round(risk.availableHours ?? -1),
            risk.burnRateBasis,
          ].join(':'),
          count: 1,
          issueAccounts: [],
        });
      }
    }

    const issueRows = latest.accounts.filter(isHardIssueRow);
    if (issueRows.length >= this.config.accountIssueThreshold) {
      candidates.push({
        kind: 'account-issues',
        severity: 'warn',
        title: '账号池使用异常',
        detail: '部分启用账号处于失败、未知或 usage 查询退避状态，需要排查账号状态。',
        message: truncateText(buildAccountIssueMessage(target, latest, issueRows), this.config.maxMessageChars),
        fingerprint: getIssueFingerprint(issueRows),
        count: issueRows.length,
        issueAccounts: issueRows,
      });
    }

    return candidates;
  }

  private shouldSend(candidate: AlertCandidate, cpaId: string): boolean {
    const key = this.getAlertKey(cpaId, candidate);
    const previous = this.sentAlerts.get(key);
    if (!previous) return true;

    const now = Date.now();
    const cooldownMs = this.config.cooldownMinutes * 60 * 1000;
    const severityIncreased = SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[previous.severity];
    const issueCountIncreased = candidate.count > previous.count;
    const fingerprintChanged = candidate.fingerprint !== previous.fingerprint;
    if (now - previous.sentAt >= cooldownMs) return true;
    return severityIncreased || (fingerprintChanged && issueCountIncreased);
  }

  private async sendCandidate(target: CpaTargetConfig, latest: LatestPayload, candidate: AlertCandidate): Promise<void> {
    const payload = this.buildPayload(target, latest, candidate);
    try {
      await this.sendSms(payload);
      this.sentAlerts.set(this.getAlertKey(target.id, candidate), {
        sentAt: Date.now(),
        severity: candidate.severity,
        fingerprint: candidate.fingerprint,
        count: candidate.count,
      });
      console.info(`Sent ${candidate.kind} SMS alert for ${target.name}: ${candidate.title}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '发送失败';
      console.error(`Failed to send ${candidate.kind} SMS alert for ${target.name}: ${message}`);
    }
  }

  private buildPayload(target: CpaTargetConfig, latest: LatestPayload, candidate: AlertCandidate): SmsWebhookPayload {
    const stats = latest.snapshot?.stats;
    const risk = latest.risk;
    return {
      type: 'quota_monitor_alert',
      channel: 'sms',
      severity: candidate.severity,
      kind: candidate.kind,
      cpaId: target.id,
      cpaName: target.name,
      recipients: this.config.recipients,
      title: candidate.title,
      detail: candidate.detail,
      message: candidate.message,
      snapshotId: latest.snapshot?.id ?? null,
      capturedAt: latest.snapshot?.capturedAt ?? null,
      metrics: {
        enabledAccounts: stats?.enabledAccounts ?? null,
        failedOrUnknownAccounts: stats?.failedOrUnknownAccounts ?? null,
        hardIssueAccounts: candidate.issueAccounts.length,
        conservativeFiveHourUsd: risk.conservativeFiveHourUsd,
        nominalFiveHourUsd: risk.nominalFiveHourUsd,
        hourlyBurnUsd: risk.hourlyBurnUsd,
        oneHourBurnUsd: risk.oneHourBurnUsd,
        threeHourBurnUsd: risk.threeHourBurnUsd,
        thirtyMinuteBurnUsd: risk.thirtyMinuteBurnUsd,
        burnRateBasis: risk.burnRateBasis,
        availableHours: risk.availableHours,
        estimatedDepletionAt: risk.estimatedDepletionAt,
        consumptionCoveragePercent: risk.consumptionCoveragePercent,
        spikeDetected: risk.spikeDetected,
        trustedCoveragePercent: risk.trustedCoveragePercent,
        freshCoveragePercent: risk.freshCoveragePercent,
      },
      issueAccounts: candidate.issueAccounts.slice(0, 10).map((row) => ({
        name: row.name,
        accountId: row.accountId,
        quotaSource: row.quotaSource,
        status: row.status,
        error: row.error,
      })),
    };
  }

  private async sendSms(payload: SmsWebhookPayload): Promise<void> {
    if (this.config.provider === 'aliyun') {
      await this.sendAliyunSms(payload);
      return;
    }
    await this.postWebhook(payload);
  }

  private getMissingAliyunConfig(): string[] {
    const missing: string[] = [];
    if (!this.config.aliyun.accessKeyId) missing.push('ALIYUN_SMS_ACCESS_KEY_ID');
    if (!this.config.aliyun.accessKeySecret) missing.push('ALIYUN_SMS_ACCESS_KEY_SECRET');
    if (!this.config.aliyun.signName) missing.push('ALIYUN_SMS_SIGN_NAME');
    if (!this.config.aliyun.templateCode) missing.push('ALIYUN_SMS_TEMPLATE_CODE');
    return missing;
  }

  private async sendAliyunSms(payload: SmsWebhookPayload): Promise<void> {
    const missing = this.getMissingAliyunConfig();
    if (missing.length > 0) {
      throw new Error(`Aliyun SMS config missing: ${missing.join(', ')}`);
    }

    const recipients = uniqueValues(this.config.recipients);
    if (recipients.length === 0) {
      throw new Error('ALERT_SMS_RECIPIENTS is empty');
    }

    const templateParam = JSON.stringify({
      [this.config.aliyun.templateParamName]: payload.message,
    });
    const url = buildAliyunSignedUrl(this.config.aliyun, {
      AccessKeyId: this.config.aliyun.accessKeyId,
      Action: 'SendSms',
      PhoneNumbers: recipients.join(','),
      RegionId: this.config.aliyun.regionId,
      SignName: this.config.aliyun.signName,
      TemplateCode: this.config.aliyun.templateCode,
      TemplateParam: templateParam,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutSeconds * 1000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });
      const text = await response.text();
      let body: AliyunSmsResponse = {};
      if (text.trim()) {
        try {
          body = JSON.parse(text) as AliyunSmsResponse;
        } catch {
          body = { Message: text };
        }
      }
      if (!response.ok) {
        throw new Error(`Aliyun SMS returned HTTP ${response.status}${body.Message ? `: ${body.Message}` : ''}`);
      }
      if (body.Code !== 'OK') {
        throw new Error(`Aliyun SMS returned ${body.Code ?? 'UNKNOWN'}${body.Message ? `: ${body.Message}` : ''}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Aliyun SMS timeout after ${this.config.timeoutSeconds}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postWebhook(payload: SmsWebhookPayload): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutSeconds * 1000);
    try {
      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.webhookToken ? { Authorization: `Bearer ${this.config.webhookToken}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`SMS webhook returned ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`SMS webhook timeout after ${this.config.timeoutSeconds}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private getAlertKey(cpaId: string, candidate: AlertCandidate): string {
    return `${cpaId}:${candidate.kind}`;
  }
}
