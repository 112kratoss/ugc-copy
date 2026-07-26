import { describe, expect, it, vi } from 'vitest';

import {
  buildBackendModerationHealth,
  collectBackendModerationHealth,
} from '@/lib/backend-moderation-health';

function queryResult({
  data,
  count,
  error = null,
}: {
  data: unknown[];
  count: number;
  error?: unknown;
}) {
  const result = Promise.resolve({ data, count, error });
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    limit: vi.fn(() => query),
    then: result.then.bind(result),
  };
  return query;
}

describe('backend moderation health', () => {
  it('reports queue depth and oldest age without alerting on a fresh queue', () => {
    const report = buildBackendModerationHealth({
      postReportCount: 2,
      subjectReportCount: 1,
      oldestPostReportCreatedAt: '2026-07-26T09:00:00.000Z',
      oldestSubjectReportCreatedAt: '2026-07-26T09:30:00.000Z',
      now: new Date('2026-07-26T10:00:00.000Z'),
    });

    expect(report).toMatchObject({
      status: 'ok',
      queue: {
        postReportCount: 2,
        subjectReportCount: 1,
        totalOpenCount: 3,
        oldestCreatedAt: '2026-07-26T09:00:00.000Z',
        oldestAgeMinutes: 60,
      },
      issues: [],
    });
  });

  it('warns on an ageing or growing queue and degrades after the review SLO', () => {
    const warning = buildBackendModerationHealth({
      postReportCount: 7,
      subjectReportCount: 3,
      oldestPostReportCreatedAt: '2026-07-26T04:00:00.000Z',
      oldestSubjectReportCreatedAt: null,
      now: new Date('2026-07-26T10:00:00.000Z'),
    });
    expect(warning.status).toBe('warning');
    expect(warning.issues.map((issue) => issue.code)).toEqual([
      'MODERATION_QUEUE_AGE_WARNING',
      'MODERATION_QUEUE_VOLUME_WARNING',
    ]);

    const degraded = buildBackendModerationHealth({
      postReportCount: 20,
      subjectReportCount: 5,
      oldestPostReportCreatedAt: '2026-07-24T10:00:00.000Z',
      oldestSubjectReportCreatedAt: null,
      now: new Date('2026-07-26T10:00:00.000Z'),
    });
    expect(degraded.status).toBe('degraded');
    expect(degraded.issues.map((issue) => issue.code)).toEqual([
      'MODERATION_QUEUE_AGE_SLO_BREACH',
      'MODERATION_QUEUE_VOLUME_OVERLOAD',
    ]);
  });

  it('collects exact counts and oldest rows from both service-only queues', async () => {
    const postReports = queryResult({
      data: [{ created_at: '2026-07-26T08:00:00.000Z' }],
      count: 4,
    });
    const subjectReports = queryResult({
      data: [{ created_at: '2026-07-26T07:00:00.000Z' }],
      count: 2,
    });
    const from = vi.fn((table: string) => {
      if (table === 'post_reports') return postReports;
      if (table === 'moderation_reports') return subjectReports;
      throw new Error(`Unexpected table: ${table}`);
    });

    const report = await collectBackendModerationHealth(
      { from } as never,
      new Date('2026-07-26T10:00:00.000Z'),
    );

    expect(report.queue).toEqual({
      postReportCount: 4,
      subjectReportCount: 2,
      totalOpenCount: 6,
      oldestCreatedAt: '2026-07-26T07:00:00.000Z',
      oldestAgeMinutes: 180,
    });
    expect(postReports.select).toHaveBeenCalledWith('created_at', { count: 'exact' });
    expect(postReports.eq).toHaveBeenCalledWith('status', 'open');
    expect(subjectReports.in).toHaveBeenCalledWith('status', ['open', 'reviewing']);
  });

  it('fails closed when either queue cannot be inspected', async () => {
    const postReports = queryResult({
      data: [],
      count: 0,
      error: { message: 'permission denied' },
    });
    const subjectReports = queryResult({ data: [], count: 0 });
    const from = vi.fn((table: string) => (
      table === 'post_reports' ? postReports : subjectReports
    ));

    await expect(collectBackendModerationHealth({ from } as never)).rejects.toThrow(
      'Failed to inspect the post moderation queue: permission denied',
    );
  });
});
