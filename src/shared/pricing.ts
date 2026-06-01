import type { PlanKey, PricingProfile, WindowId } from './domain';

export const DEFAULT_PRICING_PROFILE: PricingProfile = {
  id: 'reference-2026-04-10',
  name: '参考图 2026-04-10',
  sourceLabel: '按社区实测折算，非官方账单金额',
  updatedAt: 0,
  plans: {
    free: {
      fiveHourUsd: null,
      weeklyUsd: 10.58,
    },
    plus: {
      fiveHourUsd: 18.77,
      weeklyUsd: 117.31,
    },
    team: {
      fiveHourUsd: 21.65,
      weeklyUsd: 135.33,
    },
    pro: {
      fiveHourUsd: 317.16,
      weeklyUsd: 1858,
    },
  },
};

const PLAN_LABELS: Record<PlanKey, string> = {
  free: '普号',
  plus: 'Plus',
  team: 'Team',
  pro: 'Pro',
  unknown: '未知',
};

export function normalizePlanKey(planType: string | null | undefined): PlanKey {
  const value = String(planType ?? '')
    .trim()
    .toLowerCase();

  if (!value) return 'unknown';
  if (value.includes('team') || value.includes('business') || value.includes('enterprise')) return 'team';
  if (value.includes('pro')) return 'pro';
  if (value.includes('plus')) return 'plus';
  if (
    value.includes('free') ||
    value.includes('normal') ||
    value.includes('default') ||
    value.includes('普号') ||
    value.includes('basic')
  ) {
    return 'free';
  }

  return 'unknown';
}

export function getPlanLabel(planKey: PlanKey, rawPlanType?: string | null): string {
  if (planKey !== 'unknown') return PLAN_LABELS[planKey];
  if (!rawPlanType) return PLAN_LABELS.unknown;
  return rawPlanType
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function getWindowFullUsd(
  profile: PricingProfile,
  planKey: PlanKey,
  windowId: WindowId,
): number | null {
  if (planKey === 'unknown') return null;
  const plan = profile.plans[planKey];
  const value = windowId === 'five-hour' ? plan.fiveHourUsd : plan.weeklyUsd;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function calculateWindowUsd(
  profile: PricingProfile,
  planKey: PlanKey,
  windowId: WindowId,
  points: number | null | undefined,
): number | null {
  if (typeof points !== 'number' || !Number.isFinite(points)) return null;
  const fullUsd = getWindowFullUsd(profile, planKey, windowId);
  if (fullUsd === null) return null;
  return (Math.max(0, Math.min(100, points)) / 100) * fullUsd;
}

export function normalizePricingProfile(value: PricingProfile): PricingProfile {
  const normalized: PricingProfile = {
    id: value.id || DEFAULT_PRICING_PROFILE.id,
    name: value.name || DEFAULT_PRICING_PROFILE.name,
    sourceLabel: value.sourceLabel || DEFAULT_PRICING_PROFILE.sourceLabel,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
    plans: {
      free: normalizePlanPricing(value.plans?.free, DEFAULT_PRICING_PROFILE.plans.free),
      plus: normalizePlanPricing(value.plans?.plus, DEFAULT_PRICING_PROFILE.plans.plus),
      team: normalizePlanPricing(value.plans?.team, DEFAULT_PRICING_PROFILE.plans.team),
      pro: normalizePlanPricing(value.plans?.pro, DEFAULT_PRICING_PROFILE.plans.pro),
    },
  };
  return normalized;
}

function normalizePlanPricing(
  input: { fiveHourUsd?: unknown; weeklyUsd?: unknown } | undefined,
  fallback: { fiveHourUsd: number | null; weeklyUsd: number | null },
) {
  return {
    fiveHourUsd: normalizePrice(input?.fiveHourUsd, fallback.fiveHourUsd),
    weeklyUsd: normalizePrice(input?.weeklyUsd, fallback.weeklyUsd),
  };
}

function normalizePrice(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

export function formatUsd(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未计价';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
