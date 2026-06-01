import type { AuthFileItem } from '../shared/domain';
import type { CpaTargetConfig } from './config';
import { HttpError } from './http';

export interface ApiCallRequest {
  authIndex?: string;
  method: string;
  url: string;
  header?: Record<string, string>;
  data?: string;
}

export interface ApiCallResult<T = unknown> {
  statusCode: number;
  header: Record<string, string[]>;
  bodyText: string;
  body: T | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function normalizeBody(input: unknown): { bodyText: string; body: unknown | null } {
  if (input === undefined || input === null) return { bodyText: '', body: null };
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return { bodyText: input, body: null };
    try {
      return { bodyText: input, body: JSON.parse(trimmed) as unknown };
    } catch {
      return { bodyText: input, body: input };
    }
  }
  try {
    return { bodyText: JSON.stringify(input), body: input };
  } catch {
    return { bodyText: String(input), body: input };
  }
}

function getErrorMessage(payload: unknown, fallback: string): string {
  const record = asRecord(payload);
  if (!record) return typeof payload === 'string' && payload.trim() ? payload : fallback;
  const error = record.error;
  const errorRecord = asRecord(error);
  if (errorRecord && typeof errorRecord.message === 'string') return errorRecord.message;
  if (typeof error === 'string') return error;
  if (typeof record.message === 'string') return record.message;
  return fallback;
}

function normalizeAuthFiles(payload: unknown): AuthFileItem[] {
  if (Array.isArray(payload)) return payload as AuthFileItem[];
  const record = asRecord(payload);
  const files = record?.files ?? record?.items;
  return Array.isArray(files) ? (files as AuthFileItem[]) : [];
}

export function getApiCallErrorMessage(result: ApiCallResult): string {
  const record = asRecord(result.body);
  let message = '';
  if (record) {
    const errorRecord = asRecord(record.error);
    if (errorRecord && typeof errorRecord.message === 'string') message = errorRecord.message;
    else if (typeof record.error === 'string') message = record.error;
    else if (typeof record.message === 'string') message = record.message;
  } else if (typeof result.body === 'string') {
    message = result.body;
  }
  if (!message && result.bodyText) message = result.bodyText;
  if (result.statusCode && message) return `${result.statusCode} ${message}`.trim();
  if (result.statusCode) return `HTTP ${result.statusCode}`;
  return message || 'Request failed';
}

export class CpaClient {
  private target: CpaTargetConfig;
  private timeoutMs: number;

  constructor(target: CpaTargetConfig, timeoutMs = 60_000) {
    this.target = target;
    this.timeoutMs = Math.max(1_000, timeoutMs);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.target.apiBase}/v0/management${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
          Authorization: `Bearer ${this.target.managementKey}`,
        },
      });
      const payload = await readResponsePayload(response);
      if (!response.ok) {
        throw new HttpError(response.status, getErrorMessage(payload, response.statusText || 'Request failed'));
      }
      return payload as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new HttpError(504, `CPA Management 请求超时：${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async listAuthFiles(): Promise<AuthFileItem[]> {
    const payload = await this.request<unknown>('/auth-files');
    return normalizeAuthFiles(payload);
  }

  async apiCall(payload: ApiCallRequest): Promise<ApiCallResult> {
    const response = await this.request<Record<string, unknown>>('/api-call', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const statusCode = Number(response.status_code ?? response.statusCode ?? 0);
    const header = (response.header ?? response.headers ?? {}) as Record<string, string[]>;
    const { bodyText, body } = normalizeBody(response.body);
    return { statusCode, header, bodyText, body };
  }
}
