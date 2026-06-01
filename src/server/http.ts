import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ServerConfig } from './config';

export const API_PREFIX = '/quota-monitor-api';
const COOKIE_NAME = 'quota_monitor_session';

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function normalizeApiBase(input: string): string {
  let base = input.trim();
  if (!base) return '';
  base = base.replace(/\/?v0\/management\/?$/i, '');
  base = base.replace(/\/+$/i, '');
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  return base;
}

export function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'Content-Type': 'application/json;charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

export async function readJsonBody<T = unknown>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function createSessionValue(config: ServerConfig): string {
  return createHmac('sha256', config.monitorKey)
    .update('quota-monitor-session-v2')
    .digest('hex');
}

function parseCookie(header: string | null): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => {
        const [key, ...rest] = part.trim().split('=');
        return [key, decodeURIComponent(rest.join('='))] as const;
      })
      .filter(([key]) => key),
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isAuthenticated(request: Request, config: ServerConfig): boolean {
  const cookie = parseCookie(request.headers.get('cookie'))[COOKIE_NAME];
  return Boolean(cookie && safeEqual(cookie, createSessionValue(config)));
}

export function requireAuth(request: Request, config: ServerConfig): void {
  if (!isAuthenticated(request, config)) {
    throw new HttpError(401, 'Unauthorized');
  }
}

export function setSessionCookie(config: ServerConfig): string {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(createSessionValue(config))}`,
    'Path=/quota-monitor-api',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=2592000',
  ];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(config: ServerConfig): string {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/quota-monitor-api',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function sanitizeTarget(target: { id: string; name: string; apiBase: string }) {
  return {
    id: target.id,
    name: target.name,
    apiBase: target.apiBase,
  };
}
