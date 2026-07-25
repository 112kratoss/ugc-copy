import { describe, expect, it } from 'vitest';

import {
  buildProviderRateIssues,
  PROVIDER_RATE_MIN_SAMPLE,
} from '@/lib/backend-cost-report';

function dependencies(
  byService: Record<string, number>,
  failuresByService: Record<string, number> = {},
  timeoutsByService: Record<string, number> = {},
) {
  return {
    recentEvents: Object.values(byService).reduce((a, b) => a + b, 0),
    failedCount: Object.values(failuresByService).reduce((a, b) => a + b, 0),
    slowCount: 0,
    maxDurationMs: 0,
    byService,
    failuresByService,
    timeoutsByService,
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
