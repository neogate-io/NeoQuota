import type { LatestPayload, PricingProfile, SessionPayload } from './shared/domain';

type RefreshCoverageMode = 'auto' | 'full-rate-limited';

interface RefreshOptions {
  all?: boolean;
  coverageMode?: RefreshCoverageMode;
  forceFull?: boolean;
}

export class ClientApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ClientApiError';
    this.status = status;
  }
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.message === 'string') return record.message;
  }
  return typeof payload === 'string' && payload ? payload : fallback;
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/quota-monitor-api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new ClientApiError(response.status, getMessage(payload, response.statusText || 'Request failed'));
  }
  return payload as T;
}

export const monitorApi = {
  session: () => apiFetch<SessionPayload & { targets?: LatestPayload['targets'] }>('/session'),
  login: (monitorKey: string) =>
    apiFetch<SessionPayload>('/login', {
      method: 'POST',
      body: JSON.stringify({ monitorKey }),
    }),
  logout: () =>
    apiFetch<SessionPayload>('/logout', {
      method: 'POST',
    }),
  latest: (cpaId?: string | null) =>
    apiFetch<LatestPayload>(`/latest${cpaId ? `?cpaId=${encodeURIComponent(cpaId)}` : ''}`),
  refresh: (cpaId: string, options: RefreshOptions = {}) =>
    apiFetch<LatestPayload>(`/refresh${cpaId ? `?cpaId=${encodeURIComponent(cpaId)}` : ''}`, {
      method: 'POST',
      body: JSON.stringify(
        options.all
          ? { all: true, coverageMode: options.coverageMode ?? 'auto', forceFull: options.forceFull }
          : { cpaId, coverageMode: options.coverageMode ?? 'auto', forceFull: options.forceFull },
      ),
    }),
  clearHistory: (cpaId: string) =>
    apiFetch<{ ok: boolean }>(`/history?cpaId=${encodeURIComponent(cpaId)}`, {
      method: 'DELETE',
    }),
  pricing: () => apiFetch<PricingProfile>('/pricing'),
  savePricing: (profile: PricingProfile) =>
    apiFetch<PricingProfile>('/pricing', {
      method: 'PUT',
      body: JSON.stringify(profile),
    }),
  exportUrl: (cpaId: string) => `/quota-monitor-api/export?cpaId=${encodeURIComponent(cpaId)}`,
};
