import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PricingProfile } from '../shared/domain';
import { normalizePricingProfile } from '../shared/pricing';
import { QuotaCollector } from './collector';
import { getRiskOptions, loadConfig } from './config';
import { QuotaMonitorDb } from './db';
import {
  API_PREFIX,
  clearSessionCookie,
  HttpError,
  isAuthenticated,
  jsonResponse,
  readJsonBody,
  requireAuth,
  sanitizeTarget,
  setSessionCookie,
} from './http';

const config = loadConfig();
const db = new QuotaMonitorDb(config.dbPath);
const collector = new QuotaCollector(config, db);
const publicTargets = config.targets.map(sanitizeTarget);
const riskOptions = getRiskOptions(config);
type RefreshCoverageMode = 'auto' | 'full-rate-limited';

function findTarget(cpaId: string | null) {
  if (!cpaId) return config.targets[0];
  return config.targets.find((target) => target.id === cpaId) ?? config.targets[0];
}

function getTargetIdFromRequest(request: Request): string {
  const url = new URL(request.url);
  return findTarget(url.searchParams.get('cpaId')).id;
}

function getLatestPayload(selectedCpaId: string) {
  return db.getLatestPayload(publicTargets, selectedCpaId, riskOptions);
}

function parseRefreshCoverageMode(body: { coverageMode?: unknown; forceFull?: unknown }): RefreshCoverageMode {
  if (body.coverageMode === 'full-rate-limited' || body.forceFull === true) return 'full-rate-limited';
  return 'auto';
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonResponse({ error: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : 'Internal server error';
  console.error(error);
  return jsonResponse({ error: message }, { status: 500 });
}

function routePath(request: Request): string {
  const url = new URL(request.url);
  return url.pathname;
}

async function handleApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'POST' && path === `${API_PREFIX}/login`) {
    const body = await readJsonBody<{ monitorKey?: unknown }>(request);
    if (String(body.monitorKey ?? '') !== config.monitorKey) {
      throw new HttpError(401, 'Monitor Key 不正确');
    }
    return jsonResponse(
      {
        authenticated: true,
        targets: publicTargets,
      },
      {
        headers: {
          'Set-Cookie': setSessionCookie(config),
        },
      },
    );
  }

  if (request.method === 'POST' && path === `${API_PREFIX}/logout`) {
    return jsonResponse(
      { authenticated: false },
      {
        headers: {
          'Set-Cookie': clearSessionCookie(config),
        },
      },
    );
  }

  if (request.method === 'GET' && path === `${API_PREFIX}/session`) {
    return jsonResponse({
      authenticated: isAuthenticated(request, config),
      targets: publicTargets,
    });
  }

  requireAuth(request, config);

  if (request.method === 'GET' && path === `${API_PREFIX}/latest`) {
    const selectedCpaId = getTargetIdFromRequest(request);
    return jsonResponse(getLatestPayload(selectedCpaId));
  }

  if (request.method === 'POST' && path === `${API_PREFIX}/refresh`) {
    const body = await readJsonBody<{
      cpaId?: unknown;
      all?: unknown;
      forceFull?: unknown;
      coverageMode?: unknown;
    }>(request);
    const coverageMode = parseRefreshCoverageMode(body);
    if (body.all === true) {
      void collector.collectAll({ coverageMode });
      const selectedCpaId = getTargetIdFromRequest(request);
      return jsonResponse(getLatestPayload(selectedCpaId));
    }

    const target = findTarget(typeof body.cpaId === 'string' ? body.cpaId : url.searchParams.get('cpaId'));
    void collector.collectTarget(target, { coverageMode });
    return jsonResponse(getLatestPayload(target.id));
  }

  if (request.method === 'DELETE' && path === `${API_PREFIX}/history`) {
    const all = url.searchParams.get('all') === 'true';
    const selectedCpaId = getTargetIdFromRequest(request);
    db.clearHistory(all ? undefined : selectedCpaId);
    return jsonResponse({ ok: true });
  }

  if (request.method === 'GET' && path === `${API_PREFIX}/export`) {
    const selectedCpaId = getTargetIdFromRequest(request);
    return jsonResponse({
      exportedAt: new Date().toISOString(),
      ...getLatestPayload(selectedCpaId),
    });
  }

  if (request.method === 'GET' && path === `${API_PREFIX}/pricing`) {
    return jsonResponse(db.getPricingProfile());
  }

  if (request.method === 'PUT' && path === `${API_PREFIX}/pricing`) {
    const body = await readJsonBody<PricingProfile>(request);
    const saved = db.savePricingProfile(normalizePricingProfile(body));
    return jsonResponse(saved);
  }

  throw new HttpError(404, 'Not found');
}

async function handleRequest(request: Request): Promise<Response> {
  try {
    const path = routePath(request);
    if (path.startsWith(API_PREFIX)) return await handleApi(request);

    if (request.method === 'GET' && (path === '/quota-monitor.html' || path === '/')) {
      const filePath = resolve('dist/quota-monitor.html');
      if (existsSync(filePath)) {
        return new Response(Bun.file(filePath), {
          headers: {
            'Content-Type': 'text/html;charset=utf-8',
          },
        });
      }
    }

    return jsonResponse({ error: 'Not found' }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}

collector.start();

const server = Bun.serve({
  port: config.port,
  fetch: handleRequest,
});

console.info(`Quota monitor server listening on http://127.0.0.1:${server.port}`);
console.info(`Configured CPA targets: ${config.targets.map((target) => `${target.name}(${target.id})`).join(', ')}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    collector.stop();
    server.stop();
    process.exit(0);
  });
}
