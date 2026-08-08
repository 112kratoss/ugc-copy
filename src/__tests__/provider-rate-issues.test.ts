import { describe, expect, it } from 'vitest';

import {
  buildProviderRateIssues,
  PROVIDER_MODEL_RATE_MIN_SAMPLE,
  PROVIDER_RATE_MIN_SAMPLE,
} from '@/lib/backend-cost-report';

function dependencies(
  byService: Record<string, number>,
  failuresByService: Record<string, number> = {},
  timeoutsByService: Record<string, number> = {},
  models: {
    byModel?: Record<string, number>;
    failuresByModel?: Record<string, number>;
    timeoutsByModel?: Record<string, number>;
  } = {},
) {
  return {
    recentEvents: Object.values(byService).reduce((a, b) => a + b, 0),
    // Only failures and slow calls are ever persisted, so this is not a
    // denominator for a failure rate.
    population: 'failures-and-slow-calls' as const,
    // The real denominator, absent in these fixtures: null means unknown.
    recentAttempts: null,
    attemptsByService: null,
    failedCount: Object.values(failuresByService).reduce((a, b) => a + b, 0),
    slowCount: 0,
    maxDurationMs: 0,
    byService,
    failuresByService,
    timeoutsByService,
    byModel: models.byModel ?? {},
    failuresByModel: models.failuresByModel ?? {},
    timeoutsByModel: models.timeoutsByModel ?? {},
  };
}

describe('per-provider rate alerting', () => {
  it('stays silent for a healthy provider', () => {
    const issues = buildProviderRateIssues(dependencies({ 'KIE image status': 100 }, { 'KIE image status': 1 }));
    expect(issues).toEqual([]);
  });

  it('ignores a service below the minimum sample so a 1-of-2 blip is not an outage', () => {
    const issues = buildProviderRateIssues(
      dependencies({ 'KIE image status': 2 }, { 'KIE image status': 2 }),
    );
    expect(issues).toEqual([]);
    expect(PROVIDER_RATE_MIN_SAMPLE).toBeGreaterThan(2);
  });

  it('warns on an elevated error rate', () => {
    const issues = buildProviderRateIssues(
      dependencies({ 'KIE image status': 100 }, { 'KIE image status': 25 }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PROVIDER_ERROR_RATE_ELEVATED');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('25%');
  });

  it('degrades on a majority error rate', () => {
    const issues = buildProviderRateIssues(
      dependencies({ 'KIE image status': 100 }, { 'KIE image status': 60 }),
    );

    expect(issues[0].code).toBe('PROVIDER_ERROR_RATE_DEGRADED');
    expect(issues[0].severity).toBe('degraded');
  });

  it('reports timeouts separately from general failures', () => {
    const issues = buildProviderRateIssues(
      dependencies(
        { 'KIE video status': 100 },
        { 'KIE video status': 15 },
        { 'KIE video status': 15 },
      ),
    );

    // 15% failures is below the error warning, but 15% timeouts is above the
    // timeout warning, so only the timeout signal fires.
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PROVIDER_TIMEOUT_RATE_ELEVATED');
  });

  it('degrades on a high timeout rate', () => {
    const issues = buildProviderRateIssues(
      dependencies(
        { 'KIE video status': 100 },
        { 'KIE video status': 35 },
        { 'KIE video status': 35 },
      ),
    );

    expect(issues.map((issue) => issue.code)).toContain('PROVIDER_TIMEOUT_RATE_DEGRADED');
  });

  it('isolates a single degrading provider from healthy ones', () => {
    const issues = buildProviderRateIssues(
      dependencies(
        { 'KIE image status': 500, 'Razorpay': 50 },
        { 'KIE image status': 2, 'Razorpay': 30 },
      ),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('Razorpay');
  });

  it('handles a service with no recorded failures', () => {
    const issues = buildProviderRateIssues(dependencies({ 'KIE image status': 100 }));
    expect(issues).toEqual([]);
  });
});

describe('per-model rate alerting', () => {
  it('surfaces one failing model that a healthy service average would hide', () => {
    // The service is fine overall — 30 failures in 500 calls is 6%, well under
    // the 20% warning — but all 30 belong to one model, which is 100% of its
    // traffic. Before per-model attribution this was invisible.
    const issues = buildProviderRateIssues(
      dependencies(
        { 'KIE task creation': 500 },
        { 'KIE task creation': 30 },
        {},
        {
          byModel: { 'nano-banana-2': 470, 'grok-imagine-image': 30 },
          failuresByModel: { 'grok-imagine-image': 30 },
        },
      ),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PROVIDER_MODEL_ERROR_RATE_DEGRADED');
    expect(issues[0].severity).toBe('degraded');
    expect(issues[0].message).toContain('Model grok-imagine-image');
    expect(issues[0].message).toContain('100%');
  });

  it('uses codes distinct from the service ones so a model is not read as a provider outage', () => {
    const issues = buildProviderRateIssues(
      dependencies(
        { 'KIE task creation': 100 },
        { 'KIE task creation': 60 },
        {},
        { byModel: { 'seedance-2': 100 }, failuresByModel: { 'seedance-2': 60 } },
      ),
    );

    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain('PROVIDER_ERROR_RATE_DEGRADED');
    expect(codes).toContain('PROVIDER_MODEL_ERROR_RATE_DEGRADED');
    expect(new Set(codes).size).toBe(2);
  });

  it('never alerts on a single failure at the minimum sample', () => {
    // The floor is chosen so one failure can never trip even the warning band.
    const issues = buildProviderRateIssues(
      dependencies({}, {}, {}, {
        byModel: { 'veo-3.1': PROVIDER_MODEL_RATE_MIN_SAMPLE },
        failuresByModel: { 'veo-3.1': 1 },
      }),
    );

    expect(issues).toEqual([]);
    expect(1 / PROVIDER_MODEL_RATE_MIN_SAMPLE).toBeLessThan(0.2);
  });

  it('warns once a second failure clears the threshold', () => {
    const issues = buildProviderRateIssues(
      dependencies({}, {}, {}, {
        byModel: { 'veo-3.1': PROVIDER_MODEL_RATE_MIN_SAMPLE },
        failuresByModel: { 'veo-3.1': 2 },
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PROVIDER_MODEL_ERROR_RATE_ELEVATED');
  });

  it('ignores a model below the minimum sample', () => {
    const issues = buildProviderRateIssues(
      dependencies({}, {}, {}, {
        byModel: { 'sound-effect-v1': PROVIDER_MODEL_RATE_MIN_SAMPLE - 1 },
        failuresByModel: { 'sound-effect-v1': PROVIDER_MODEL_RATE_MIN_SAMPLE - 1 },
      }),
    );

    expect(issues).toEqual([]);
  });

  it('reports model timeouts separately from model failures', () => {
    const issues = buildProviderRateIssues(
      dependencies({}, {}, {}, {
        byModel: { 'kling-3.0-video': 100 },
        failuresByModel: { 'kling-3.0-video': 15 },
        timeoutsByModel: { 'kling-3.0-video': 15 },
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('PROVIDER_MODEL_TIMEOUT_RATE_ELEVATED');
  });

  it('has a lower floor than the service dimension, since a model sees less traffic', () => {
    expect(PROVIDER_MODEL_RATE_MIN_SAMPLE).toBeLessThan(PROVIDER_RATE_MIN_SAMPLE);
  });

  it('stays silent when nothing is model-attributed', () => {
    const issues = buildProviderRateIssues(dependencies({ 'Razorpay': 100 }, { 'Razorpay': 1 }));
    expect(issues).toEqual([]);
  });
});
