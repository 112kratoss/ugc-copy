import { describe, expect, it, vi } from 'vitest';

import {
  FEED_EVENT_RETENTION_DAYS,
  FEED_FACT_RETENTION_DAYS,
} from '@/lib/feed-retention-policy';
import {
  buildFeedRetentionLagEntry,
  buildFeedRetentionPolicySkewIssue,
  collectFeedRetentionLag,
  FEED_RETENTION_LAG_DEGRADED_DAYS,
  FEED_RETENTION_LAG_WARNING_DAYS,
  FEED_RETENTION_WINDOWS,
} from '@/lib/feed-retention-lag';

const NOW = new Date('2026-08-09T12:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 86_400_000).toISOString();
}

function clientReturning(rows: unknown, error: unknown = null) {
  return { rpc: vi.fn().mockResolvedValue({ data: rows, error }) };
}

describe('feed retention windows', () => {
  it('tracks the decided 30-day raw fact window', () => {
    // Decision #2. The 5,000 MAU gate arithmetic runs on this number, and at
    // ~1 KB per row the old 400-day setting projected ~24 GiB against an 8 GiB
    // included quota.
    expect(FEED_FACT_RETENTION_DAYS).toBe(30);
    expect(FEED_RETENTION_WINDOWS.feed_delivery_facts).toBe(30);
  });

  it('never prunes facts before the events that reference them', () => {
    // `prune_feed_personalization_data` raises when facts would be pruned
    // first, because `feed_events.delivery_fact_id` points at facts. Violating
    // it does not fail one step — it aborts the entire hourly job, so the stats
    // refreshes and the whole prune stop too.
    //
    // This is asserted here because nothing else can catch it locally: the
    // maintenance unit tests mock the RPC, so the database-side guard never
    // runs, and the constants reach it only in production. Lowering facts to 30
    // while events stayed at 90 broke every feed-maintenance run until it was
    // spotted in `backend_job_runs`.
    expect(FEED_FACT_RETENTION_DAYS).toBeGreaterThanOrEqual(FEED_EVENT_RETENTION_DAYS);
  });
});

describe('feed retention lag', () => {
  it('reads 0 lag for a table the sweep is keeping up with, at any size', () => {
    // The property that makes lag a better signal than a row budget: a table
    // can be enormous and still perfectly pruned.
    const entry = buildFeedRetentionLagEntry({
      tableName: 'feed_delivery_facts',
      oldestRowAt: daysAgo(29),
      rowCount: 5_000_000,
      now: NOW,
    });

    expect(entry.lagDays).toBe(0);
    expect(entry.status).toBe('ok');
  });

  it('grades a sweep falling behind, then one that has stopped', () => {
    const slipping = buildFeedRetentionLagEntry({
      tableName: 'feed_delivery_facts',
      oldestRowAt: daysAgo(30 + FEED_RETENTION_LAG_WARNING_DAYS + 1),
      rowCount: 100,
      now: NOW,
    });
    const stalled = buildFeedRetentionLagEntry({
      tableName: 'feed_delivery_facts',
      oldestRowAt: daysAgo(30 + FEED_RETENTION_LAG_DEGRADED_DAYS + 1),
      rowCount: 100,
      now: NOW,
    });

    expect(slipping.status).toBe('warning');
    expect(stalled.status).toBe('degraded');
    expect(stalled.lagDays).toBeGreaterThan(slipping.lagDays);
  });

  it('reports an empty table as null age rather than zero', () => {
    // Zero would read as "the oldest row is brand new", which is a different
    // claim from "nothing is retained".
    const entry = buildFeedRetentionLagEntry({
      tableName: 'feed_events',
      oldestRowAt: null,
      rowCount: 0,
      now: NOW,
    });

    expect(entry.ageDays).toBeNull();
    expect(entry.lagDays).toBe(0);
    expect(entry.status).toBe('ok');
  });

  it('names the cap in the breach message, because that is the thing to raise', async () => {
    const report = await collectFeedRetentionLag(clientReturning([
      { table_name: 'feed_delivery_facts', oldest_row_at: daysAgo(45), row_count: '900000' },
    ]), NOW);

    expect(report.status).toBe('degraded');
    expect(report.issues[0].message).toContain('5,000 rows/hour');
    expect(report.issues[0].tableName).toBe('feed_delivery_facts');
    // bigint arrives as a string over PostgREST.
    expect(report.tables[0].rowCount).toBe(900000);
  });

  it('treats an unavailable probe as unmonitored, not healthy', async () => {
    const report = await collectFeedRetentionLag(clientReturning(null, new Error('missing function')), NOW);

    expect(report.status).toBe('warning');
    expect(report.issues[0].message).toContain('unmonitored rather than healthy');
  });

  it('survives a client that cannot call the RPC at all', async () => {
    // A database missing the function and a client that cannot reach it are the
    // same fact to a monitor, and neither may throw out of the collector.
    const broken = { rpc: vi.fn().mockRejectedValue(new Error('no such function')) };

    await expect(collectFeedRetentionLag(broken, NOW)).resolves.toMatchObject({ status: 'warning' });
  });

  it('is ok and silent when both tables are within their windows', async () => {
    const report = await collectFeedRetentionLag(clientReturning([
      { table_name: 'feed_delivery_facts', oldest_row_at: daysAgo(12), row_count: '14983' },
      { table_name: 'feed_events', oldest_row_at: daysAgo(29), row_count: '4403' },
    ]), NOW);

    expect(report.status).toBe('ok');
    expect(report.issues).toEqual([]);
  });
});

describe('buildFeedRetentionPolicySkewIssue', () => {
  it('reports a warning when facts are configured shorter than events', () => {
    // The 2026-08-09 incident's signature: the prune clamps this skew silently,
    // so health has to be the layer that keeps it visible.
    const issue = buildFeedRetentionPolicySkewIssue(30, 90);

    expect(issue).not.toBeNull();
    expect(issue?.severity).toBe('warning');
    expect(issue?.code).toBe('FEED_RETENTION_POLICY_SKEW');
    expect(issue?.message).toContain('30 day(s)');
    expect(issue?.message).toContain('90');
  });

  it('is silent when the windows are aligned or facts retain longer', () => {
    expect(buildFeedRetentionPolicySkewIssue(30, 30)).toBeNull();
    expect(buildFeedRetentionPolicySkewIssue(400, 90)).toBeNull();
  });

  it('pins the live policy constants as unskewed', () => {
    // This assertion is the config regression test: it fails the suite the
    // moment someone reintroduces a fact window shorter than the event window,
    // which is exactly the state that broke feed maintenance hourly.
    expect(
      buildFeedRetentionPolicySkewIssue(FEED_FACT_RETENTION_DAYS, FEED_EVENT_RETENTION_DAYS),
    ).toBeNull();
  });
});
