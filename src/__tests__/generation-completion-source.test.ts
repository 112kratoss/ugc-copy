import { describe, expect, it, vi } from 'vitest';

import {
  collectGenerationCompletionSources,
  summarizeGenerationCompletionSources,
} from '@/lib/generation-completion-source';

describe('generation completion source breakdown', () => {
  it('splits attributed completions between the two runners', () => {
    const summary = summarizeGenerationCompletionSources([
      { completed_via: 'webhook_drain' },
      { completed_via: 'webhook_drain' },
      { completed_via: 'webhook_drain' },
      { completed_via: 'cron_sweep' },
    ]);

    expect(summary.webhookDrain).toBe(3);
    expect(summary.cronSweep).toBe(1);
    expect(summary.attributed).toBe(4);
    expect(summary.webhookDrainShare).toBe(0.75);
  });

  it('counts pre-column jobs separately instead of folding them into a runner', () => {
    // Jobs completed before `completed_via` existed carry null. Attributing
    // them to either runner would skew the ratio the queue decision rests on.
    const summary = summarizeGenerationCompletionSources([
      { completed_via: null },
      { completed_via: null },
      { completed_via: 'webhook_drain' },
    ]);

    expect(summary.unattributed).toBe(2);
    expect(summary.attributed).toBe(1);
    expect(summary.webhookDrainShare).toBe(1);
  });

  it('reports a null share when nothing is attributed yet', () => {
    // Distinct from 0: "no data" and "the drain handled none of them" would
    // lead to opposite conclusions about whether a durable queue is needed.
    const summary = summarizeGenerationCompletionSources([{ completed_via: null }]);
    expect(summary.webhookDrainShare).toBeNull();
    expect(summary.attributed).toBe(0);
  });

  it('treats an unknown attribution value as unattributed rather than trusting it', () => {
    const summary = summarizeGenerationCompletionSources([{ completed_via: 'something-else' }]);
    expect(summary.unattributed).toBe(1);
    expect(summary.attributed).toBe(0);
  });

  it('queries only terminal jobs inside the window', async () => {
    const calls: Record<string, unknown[]> = { not: [], gte: [] };
    const builder = {
      select: vi.fn(() => builder),
      not: vi.fn((...args: unknown[]) => { calls.not.push(args); return builder; }),
      gte: vi.fn((...args: unknown[]) => { calls.gte.push(args); return builder; }),
      limit: vi.fn(async () => ({ data: [{ completed_via: 'cron_sweep' }], error: null })),
    };
    const client = { from: vi.fn(() => builder) };

    const summary = await collectGenerationCompletionSources(
      client as never,
      new Date('2026-07-25T12:00:00.000Z'),
      24,
    );

    expect(client.from).toHaveBeenCalledWith('generation_completion_jobs');
    expect(calls.not[0]).toEqual(['completed_at', 'is', null]);
    expect(calls.gte[0]).toEqual(['completed_at', '2026-07-24T12:00:00.000Z']);
    expect(summary.cronSweep).toBe(1);
  });

  it('fails soft on a database that predates the column', async () => {
    const builder = {
      select: vi.fn(() => builder),
      not: vi.fn(() => builder),
      gte: vi.fn(() => builder),
      limit: vi.fn(async () => ({ data: null, error: { message: 'column does not exist' } })),
    };
    const client = { from: vi.fn(() => builder) };

    const summary = await collectGenerationCompletionSources(client as never);

    // A reporting surface must not take down the whole cost report.
    expect(summary.attributed).toBe(0);
    expect(summary.webhookDrainShare).toBeNull();
  });
});

describe('generation completion source resilience', () => {
  it('fails soft when the client cannot build the query at all', async () => {
    // A stub client whose builder lacks .not() throws rather than returning an
    // error. The cost report must still be produced.
    const client = { from: vi.fn(() => ({ select: vi.fn(() => ({})) })) };

    const summary = await collectGenerationCompletionSources(client as never);

    expect(summary.attributed).toBe(0);
    expect(summary.webhookDrainShare).toBeNull();
  });
});
