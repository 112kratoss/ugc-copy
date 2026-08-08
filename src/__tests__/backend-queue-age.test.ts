import { describe, expect, it } from 'vitest';

import { BACKEND_JOB_REGISTRY } from '@/lib/backend-jobs';
import {
  buildQueueAgeEntry,
  collectBackendQueueAgeHealth,
  QUEUE_AGE_DEGRADED_CADENCE_MULTIPLIER,
  QUEUE_AGE_SLO_CADENCE_MULTIPLIER,
  type QueueClient,
} from '@/lib/backend-queue-age';

const NOW = new Date('2026-08-09T12:00:00.000Z');

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

/**
 * Chainable stub shaped like the PostgREST builder the collector uses. Records
 * the filters applied so the "only due items count" contract can be asserted
 * rather than assumed.
 */
function stubClient(
  oldestByTable: Record<string, string | null | Error>,
  calls: Record<string, string[]> = {},
): QueueClient {
  return {
    from(table: string) {
      calls[table] ??= [];
      const filters = calls[table];
      const builder: Record<string, unknown> = {};
      const chain = () => builder;

      builder.select = (columns: string) => { filters.push(`select:${columns}`); return chain(); };
      builder.eq = (column: string, value: unknown) => { filters.push(`eq:${column}=${String(value)}`); return chain(); };
      builder.in = (column: string, values: string[]) => { filters.push(`in:${column}=${values.join('|')}`); return chain(); };
      builder.lte = (column: string, value: string) => { filters.push(`lte:${column}=${value}`); return chain(); };
      builder.order = (column: string, options: { ascending: boolean }) => {
        filters.push(`order:${column}:${options.ascending ? 'asc' : 'desc'}`);
        return chain();
      };
      builder.limit = (count: number) => { filters.push(`limit:${count}`); return chain(); };
      builder.maybeSingle = async () => {
        const configured = oldestByTable[table];
        if (configured instanceof Error) return { data: null, error: configured };
        if (configured === null || configured === undefined) return { data: null, error: null };
        const column = filters.some((entry) => entry.startsWith('select:created_at'))
          ? 'created_at'
          : 'next_attempt_at';
        return { data: { [column]: configured }, error: null };
      };

      return builder as unknown as ReturnType<QueueClient['from']>;
    },
  };
}

describe('queue-age SLO derivation', () => {
  it('derives the SLO from the owning job’s cadence rather than a hand-set constant', () => {
    // A schedule change must move the SLO with it. A hardcoded threshold would
    // keep asserting the old cadence silently -- the same drift F14 guarded
    // against by asserting vercel.json against this registry.
    const completions = BACKEND_JOB_REGISTRY.find((job) => job.name === 'generation-completions');
    const repair = BACKEND_JOB_REGISTRY.find((job) => job.name === 'media-preview-repair');

    const completionEntry = buildQueueAgeEntry({
      queue: 'generation_completion_jobs', job: 'generation-completions', oldestDueAt: null, now: NOW,
    });
    const repairEntry = buildQueueAgeEntry({
      queue: 'post_media_renditions', job: 'media-preview-repair', oldestDueAt: null, now: NOW,
    });

    expect(completionEntry.sloMinutes).toBe(completions!.cadenceMinutes * QUEUE_AGE_SLO_CADENCE_MULTIPLIER);
    expect(repairEntry.sloMinutes).toBe(repair!.cadenceMinutes * QUEUE_AGE_SLO_CADENCE_MULTIPLIER);
    // The two queues genuinely have different cadences, so this would catch a
    // single shared threshold masquerading as a derivation.
    expect(completionEntry.sloMinutes).not.toBe(repairEntry.sloMinutes);
  });

  it('reports an empty queue as null age, never zero', () => {
    // Zero would read as "the oldest item is brand new", which is a different
    // and much less reassuring claim than "nothing is waiting".
    const entry = buildQueueAgeEntry({
      queue: 'generation_completion_jobs', job: 'generation-completions', oldestDueAt: null, now: NOW,
    });

    expect(entry.ageMinutes).toBeNull();
    expect(entry.status).toBe('ok');
    expect(entry.readable).toBe(true);
  });

  it('grades within SLO, past SLO, and not-draining separately', () => {
    const within = buildQueueAgeEntry({
      queue: 'q', job: 'generation-completions', oldestDueAt: minutesAgo(15), now: NOW,
    });
    const breached = buildQueueAgeEntry({
      queue: 'q', job: 'generation-completions', oldestDueAt: minutesAgo(25), now: NOW,
    });
    const notDraining = buildQueueAgeEntry({
      queue: 'q', job: 'generation-completions', oldestDueAt: minutesAgo(90), now: NOW,
    });

    // 10-minute cadence -> 20-minute SLO, 40-minute not-draining line.
    expect(within.status).toBe('ok');
    expect(breached.status).toBe('warning');
    expect(notDraining.status).toBe('degraded');
    expect(notDraining.degradedMinutes).toBe(within.cadenceMinutes * QUEUE_AGE_DEGRADED_CADENCE_MULTIPLIER);
  });

  it('treats an unprobeable queue as unmonitored, not healthy', () => {
    // The F15a lesson in miniature: monitoring that cannot see must not get
    // more optimistic. `ageMinutes: null` alone is ambiguous -- it is also the
    // empty-queue answer -- so `readable` carries the distinction.
    const entry = buildQueueAgeEntry({
      queue: 'q', job: 'generation-completions', oldestDueAt: null, now: NOW, readable: false,
    });

    expect(entry.status).toBe('warning');
    expect(entry.readable).toBe(false);
    expect(entry.ageMinutes).toBeNull();
  });
});

describe('queue-age collection', () => {
  it('covers the workflow step queue F12 shipped without any health surface', async () => {
    const { health } = await collectBackendQueueAgeHealth(stubClient({}), NOW);

    expect(health.queues.map((entry) => entry.queue)).toEqual([
      'generation_completion_jobs',
      'workflow_run_step_jobs',
      'post_media_renditions',
    ]);
  });

  it('counts only items that are actually due', async () => {
    // An item deferred by backoff is not late. Ageing a healthy retry schedule
    // from creation would report a permanent breach.
    const calls: Record<string, string[]> = {};
    await collectBackendQueueAgeHealth(stubClient({}, calls), NOW);

    expect(calls.generation_completion_jobs).toContain(`lte:next_attempt_at=${NOW.toISOString()}`);
    expect(calls.workflow_run_step_jobs).toContain(`lte:next_attempt_at=${NOW.toISOString()}`);
    expect(calls.generation_completion_jobs).toContain('order:next_attempt_at:asc');
    expect(calls.generation_completion_jobs).toContain('limit:1');
  });

  it('reads the single oldest row rather than filtering a capped sample', async () => {
    // Deriving age from a 200-row sample understates it exactly when the queue
    // is deep enough to matter, which is the failure F15a was filed for.
    const calls: Record<string, string[]> = {};
    await collectBackendQueueAgeHealth(stubClient({}, calls), NOW);

    for (const table of ['generation_completion_jobs', 'workflow_run_step_jobs', 'post_media']) {
      expect(calls[table]).toContain('limit:1');
    }
  });

  it('raises a breach naming the queue, its age and the cadence it was derived from', async () => {
    const { health, issues } = await collectBackendQueueAgeHealth(
      stubClient({ workflow_run_step_jobs: minutesAgo(35) }),
      NOW,
    );

    expect(health.status).toBe('warning');
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('QUEUE_AGE_SLO_BREACH');
    expect(issues[0].message).toContain('workflow_run_step_jobs');
    expect(issues[0].message).toContain('20-minute SLO');
  });

  it('escalates to degraded when a queue is not draining at all', async () => {
    const { health, issues } = await collectBackendQueueAgeHealth(
      stubClient({ generation_completion_jobs: minutesAgo(300) }),
      NOW,
    );

    expect(health.status).toBe('degraded');
    expect(issues[0].code).toBe('QUEUE_AGE_NOT_DRAINING');
  });

  it('flags a failed probe instead of passing it as ok', async () => {
    const { health, issues } = await collectBackendQueueAgeHealth(
      stubClient({ post_media: new Error('permission denied') }),
      NOW,
    );

    expect(health.status).toBe('warning');
    expect(issues[0].code).toBe('QUEUE_AGE_UNREADABLE');
    expect(health.queues.find((entry) => entry.queue === 'post_media_renditions')?.readable).toBe(false);
  });

  it('stays ok and silent when every queue is empty', async () => {
    const { health, issues } = await collectBackendQueueAgeHealth(stubClient({}), NOW);

    expect(health.status).toBe('ok');
    expect(issues).toEqual([]);
  });
});
