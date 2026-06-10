import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { CollectorState, LatestPayload, PricingProfile } from './shared/domain';

interface RefreshOptions {
  all?: boolean;
  coverageMode?: 'auto' | 'full-rate-limited';
  forceFull?: boolean;
}

export interface CpaTargetConfig {
  id: string;
  name: string;
  apiBase: string;
  enabled: boolean;
  hasManagementKey: boolean;
}

export interface SaveTargetInput {
  id?: string | null;
  name: string;
  apiBase: string;
  enabled: boolean;
  managementKey?: string | null;
}

export interface TestTargetConnectionResult {
  ok: boolean;
  totalAuthFiles: number;
  codexAuthFiles: number;
}

export interface EmailAlertSettings {
  enabled: boolean;
  recipients: string[];
  minTone: 'watch' | 'warn' | 'critical';
  accountIssueThreshold: number;
  cooldownMinutes: number;
  softIssueCooldownMinutes: number;
  timeoutSeconds: number;
  maxMessageChars: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUsername: string;
  smtpFrom: string;
  hasSmtpPassword: boolean;
}

export interface SaveEmailAlertSettings extends EmailAlertSettings {
  smtpPassword?: string;
}

export interface CollectorSettings {
  autoCollectEnabled: boolean;
  collectUsageTickSeconds: number;
  collectUsageMaxRequestsPerMinute: number;
  collectUsageMode: string;
  collectConcurrency: number;
  collectManualConcurrency: number;
}

export interface SaveCollectorSettings {
  autoCollectEnabled: boolean;
  collectUsageTickSeconds?: number;
  collectUsageTickMinutes?: number;
  collectUsageMaxRequestsPerMinute?: number;
  collectConcurrency?: number;
  collectManualConcurrency?: number;
}

export interface AppStatePayload {
  configured: boolean;
  targets: CpaTargetConfig[];
  paused: boolean;
  collector: CollectorSettings;
  emailAlert: EmailAlertSettings;
  pricingProfile: PricingProfile;
}

export interface CollectorPausedPayload {
  paused: boolean;
  collector?: CollectorSettings;
}

export class ClientApiError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ClientApiError';
    this.status = status;
  }
}

async function desktopInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new ClientApiError(error instanceof Error ? error.message : String(error || 'Request failed'));
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function safeListen<T>(eventName: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return Promise.resolve(() => undefined);
  return listen<T>(eventName, (event) => handler(event.payload));
}

export const monitorApi = {
  appState: () => desktopInvoke<AppStatePayload>('get_app_state'),
  listTargets: () => desktopInvoke<CpaTargetConfig[]>('list_targets'),
  saveTarget: (target: SaveTargetInput) => desktopInvoke<CpaTargetConfig>('save_target', { target }),
  deleteTarget: (targetId: string) => desktopInvoke<{ ok: boolean }>('delete_target', { targetId }),
  testTargetConnection: (target: SaveTargetInput) =>
    desktopInvoke<TestTargetConnectionResult>('test_target_connection', { target }),
  latest: (cpaId?: string | null) => desktopInvoke<LatestPayload>('get_latest', { cpaId: cpaId ?? null }),
  refresh: (cpaId: string, _options: RefreshOptions = {}) => desktopInvoke<LatestPayload>('refresh_target', { cpaId }),
  refreshAccount: (cpaId: string, accountKey: string) =>
    desktopInvoke<LatestPayload>('refresh_account', { cpaId, accountKey }),
  setAccountDisabled: (cpaId: string, authFileName: string, disabled: boolean) =>
    desktopInvoke<LatestPayload>('set_account_disabled', { cpaId, authFileName, disabled }),
  deleteAccountCredential: (cpaId: string, authFileName: string) =>
    desktopInvoke<LatestPayload>('delete_account_credential', { cpaId, authFileName }),
  clearHistory: (cpaId: string) => desktopInvoke<{ ok: boolean }>('clear_history', { cpaId }),
  pricing: () => desktopInvoke<PricingProfile>('get_pricing'),
  savePricing: (profile: PricingProfile) => desktopInvoke<PricingProfile>('save_pricing', { profile }),
  alertSettings: () => desktopInvoke<EmailAlertSettings>('get_alert_settings'),
  saveAlertSettings: (settings: SaveEmailAlertSettings) =>
    desktopInvoke<EmailAlertSettings>('save_alert_settings', { settings }),
  saveCollectorSettings: (settings: SaveCollectorSettings) =>
    desktopInvoke<CollectorSettings>('save_collector_settings', { settings }),
  sendTestEmail: (settings: SaveEmailAlertSettings) => desktopInvoke<{ ok: boolean }>('send_test_email', { settings }),
  exportSnapshot: (cpaId: string) => desktopInvoke<LatestPayload & { exportedAt: number }>('export_snapshot', { cpaId }),
  pauseCollector: () => desktopInvoke<CollectorPausedPayload>('pause_collector'),
  resumeCollector: () => desktopInvoke<CollectorPausedPayload>('resume_collector'),
  onLatestPayload: (handler: (payload: LatestPayload) => void): Promise<UnlistenFn> =>
    safeListen<LatestPayload>('latest-payload', handler),
  onCollectorState: (handler: (payload: { cpaId: string; collectorState: CollectorState }) => void): Promise<UnlistenFn> =>
    safeListen<{ cpaId: string; collectorState: CollectorState }>('collector-state', handler),
  onCollectorPaused: (handler: (payload: CollectorPausedPayload) => void): Promise<UnlistenFn> =>
    safeListen<CollectorPausedPayload>('collector-paused', handler),
};
