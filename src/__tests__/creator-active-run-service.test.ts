import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  ACTIVE_RUN_PAGE,
  findCreatorActiveRun,
  parseCreatorActiveRunTool,
} from '@/lib/creator-active-run-service';
import { createStoredRows, databaseError } from './fixtures/stored-rows';

type Row = Record<string, unknown>;

/**
 * A generations row as the starts write one, newest first in each table below: the
 * fixture applies filters but keeps the stored order, as `created_at desc` would.
 */
function run(id: string, overrides: Row = {}): Row {
  return {
    id,
    user_id: 'account-1',
    prediction_id: `pred-${id}`,
    status: 'processing',
    created_at: '2026-10-31T09:00:00.000+00:00',
    prompt: `Prompt of ${id}`,
    cost: 8,
    model: 'nano-banana-2',
    duration: null,
    category: 'image',
    creation_mode: null,
    template_run_id: null,
    template_run_step_id: null,
    archived_at: null,
    ...overrides,
  };
}

function stored(generations: Row[], canvasSteps: Row[] = []) {
  return createStoredRows({ generations, workflow_canvas_run_steps: canvasSteps });
}

/** The `order` and `range` each read asks for; the fixture keeps the stored order. */
function recordOrdering(client: SupabaseClient) {
  const asked: unknown[][] = [];
  const from = client.from.bind(client);
  Object.assign(client, {
    from(table: string) {
      const reads = from(table);
      return {
        ...reads,
        select(columns: string) {
          const query = reads.select(columns) as unknown as Record<string, (...args: unknown[]) => unknown>;
          for (const method of ['order', 'range']) {
            const original = query[method];
            query[method] = (...args: unknown[]) => {
              asked.push([table, method, ...args]);
              return original.apply(query, args);
            };
          }
          return query;
        },
      };
    },
  });
  return asked;
}

describe('findCreatorActiveRun', () => {
  it('answers each creator with its own run at work, as the creators read it', async () => {
    const { client } = stored([
      run('motion-1', { category: 'video', creation_mode: 'motion', model: 'kling-3.0', duration: 8, cost: 30, status: 'waiting' }),
      run('video-1', { category: 'video', model: 'seedance-2-mini', cost: 19 }),
      run('image-1'),
    ]);

    await expect(findCreatorActiveRun({ client, userIds: ['account-1'], tool: 'image' })).resolves.toEqual({
      id: 'image-1',
      predictionId: 'pred-image-1',
      status: 'processing',
      createdAt: '2026-10-31T09:00:00.000+00:00',
      prompt: 'Prompt of image-1',
      cost: 8,
      model: 'nano-banana-2',
      duration: null,
    });
    await expect(findCreatorActiveRun({ client, userIds: ['account-1'], tool: 'video' })).resolves.toMatchObject({ id: 'video-1', cost: 19 });
    await expect(findCreatorActiveRun({ client, userIds: ['account-1'], tool: 'motion' })).resolves.toMatchObject({
      id: 'motion-1',
      status: 'waiting',
      duration: 8,
    });
  });

  it('reads the caller and the guests linked to it, and nobody else', async () => {
    const { client } = stored([
      run('someone-elses', { user_id: 'account-2' }),
      run('made-as-a-guest', { user_id: 'guest-1' }),
    ]);

    await expect(findCreatorActiveRun({ client, userIds: ['account-1', 'guest-1'], tool: 'image' })).resolves.toMatchObject({ id: 'made-as-a-guest' });
    await expect(findCreatorActiveRun({ client, userIds: ['account-1'], tool: 'image' })).resolves.toBeNull();
  });

  it('passes over runs its creator cannot follow or should not show', async () => {
    const { client } = stored([
      run('finished', { status: 'succeeded' }),
      run('failed', { status: 'failed' }),
      run('not-submitted', { prediction_id: null }),
      run('template-run', { template_run_id: 'template-run-1' }),
      run('template-step', { template_run_step_id: 'template-step-1' }),
      run('deleted', { archived_at: '2026-10-31T09:05:00.000+00:00' }),
      run('at-work'),
    ]);

    await expect(findCreatorActiveRun({ client, userIds: ['account-1'], tool: 'image' })).resolves.toMatchObject({ id: 'at-work' });
  });

  it('leaves a run a workflow canvas holds to the canvas', async () => {
    const { client } = stored(
      [run('canvas-node'), run('from-the-creator')],
      [{ generation_id: 'canvas-node' }],
    );

    await expect(findCreatorActiveRun({ client, userIds: ['account-1'], tool: 'image' })).resolves.toMatchObject({ id: 'from-the-creator' });
  });

  it('answers null when every run at work is a canvas\'s, or none is', async () => {
    const canvasOnly = stored([run('canvas-node')], [{ generation_id: 'canvas-node' }]);
    await expect(findCreatorActiveRun({ client: canvasOnly.client, userIds: ['account-1'], tool: 'image' })).resolves.toBeNull();

    const idle = stored([run('finished', { status: 'succeeded' })]);
    await expect(findCreatorActiveRun({ client: idle.client, userIds: ['account-1'], tool: 'image' })).resolves.toBeNull();
    // With nothing at work the canvas steps are not read.
    expect(idle.reads.map((read) => read.table)).toEqual(['generations']);
  });

  it('reads the newest runs first, a page at a time', async () => {
    const { client } = stored([run('image-1')]);
    const asked = recordOrdering(client);

    await findCreatorActiveRun({ client, userIds: ['account-1'], tool: 'image' });

    expect(asked).toEqual([
      ['generations', 'order', 'created_at', { ascending: false }],
      ['generations', 'range', 0, ACTIVE_RUN_PAGE - 1],
    ]);
  });

  it('reads on past a page of runs a canvas holds to the creator\'s own', async () => {
    const canvasNodes = Array.from({ length: ACTIVE_RUN_PAGE + 2 }, (_, index) => run(`canvas-node-${index}`));
    const steps = canvasNodes.map((node) => ({ generation_id: node.id }));

    const behind = stored([...canvasNodes, run('from-the-creator')], steps);
    await expect(findCreatorActiveRun({ client: behind.client, userIds: ['account-1'], tool: 'image' }))
      .resolves.toMatchObject({ id: 'from-the-creator' });
    expect(behind.reads.map((read) => read.table)).toEqual(['generations', 'workflow_canvas_run_steps', 'generations', 'workflow_canvas_run_steps']);

    const canvasOnly = stored(canvasNodes, steps);
    await expect(findCreatorActiveRun({ client: canvasOnly.client, userIds: ['account-1'], tool: 'image' })).resolves.toBeNull();
  });

  it('throws a failed read for the route to log', async () => {
    const failedRuns = createStoredRows({ generations: databaseError('42501', 'permission denied for table generations') });
    await expect(findCreatorActiveRun({ client: failedRuns.client, userIds: ['account-1'], tool: 'image' }))
      .rejects.toEqual({ code: '42501', message: 'permission denied for table generations' });

    const failedSteps = createStoredRows({
      generations: [run('image-1')],
      workflow_canvas_run_steps: databaseError('57014', 'canceling statement due to statement timeout'),
    });
    await expect(findCreatorActiveRun({ client: failedSteps.client, userIds: ['account-1'], tool: 'image' }))
      .rejects.toEqual({ code: '57014', message: 'canceling statement due to statement timeout' });
  });
});

describe('parseCreatorActiveRunTool', () => {
  it.each(['image', 'video', 'motion'] as const)('reads %s', (tool) => {
    expect(parseCreatorActiveRunTool(tool)).toBe(tool);
  });

  it.each([null, '', 'audio', 'Image', 'image '])('refuses %j', (value) => {
    expect(parseCreatorActiveRunTool(value)).toBeNull();
  });
});
