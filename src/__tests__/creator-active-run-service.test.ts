import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  findCreatorActiveRun,
  parseCreatorActiveRunTool,
  type CreatorActiveRunTool,
} from '@/lib/creator-active-run-service';

type Call = [string, ...unknown[]];

/** A service client whose one query records each step and answers `result`. */
function recordingClient(result: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'in', 'eq', 'is', 'not', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  }
  builder.maybeSingle = async () => {
    calls.push(['maybeSingle']);
    return result;
  };
  const client = {
    from: vi.fn((table: string) => {
      calls.push(['from', table]);
      return builder;
    }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

const ROW = {
  id: 'gen-1',
  prediction_id: 'pred-1',
  status: 'waiting',
  created_at: '2026-10-31T09:10:02.087+00:00',
  prompt: 'A lighthouse at dawn',
  cost: 8,
  model: 'nano-banana-2',
  duration: null,
};

const SHARED_FILTERS: Call[] = [
  ['from', 'generations'],
  ['select', 'id, prediction_id, status, created_at, prompt, cost, model, duration'],
  ['in', 'user_id', ['account-1', 'guest-1']],
];

const TAIL_FILTERS: Call[] = [
  ['in', 'status', ['processing', 'waiting']],
  ['not', 'prediction_id', 'is', null],
  ['is', 'template_run_id', null],
  ['is', 'template_run_step_id', null],
  ['is', 'archived_at', null],
];

const NEWEST_ONE: Call[] = [
  ['order', 'created_at', { ascending: false }],
  ['limit', 1],
  ['maybeSingle'],
];

describe('findCreatorActiveRun', () => {
  it.each([
    ['image', [['eq', 'category', 'image']], []],
    ['video', [['eq', 'category', 'video']], [['is', 'creation_mode', null]]],
    ['motion', [['eq', 'category', 'video']], [['eq', 'creation_mode', 'motion']]],
  ] as Array<[CreatorActiveRunTool, Call[], Call[]]>)('asks for the newest %s run at work that its creator can follow', async (tool, category, mode) => {
    const { client, calls } = recordingClient({ data: null, error: null });

    await findCreatorActiveRun({ client, userIds: ['account-1', 'guest-1'], tool });

    expect(calls).toEqual([...SHARED_FILTERS, ...category, ...TAIL_FILTERS, ...mode, ...NEWEST_ONE]);
  });

  it('answers the run as the creators read it', async () => {
    const { client } = recordingClient({ data: ROW, error: null });

    await expect(findCreatorActiveRun({ client, userIds: ['account-1'], tool: 'image' })).resolves.toEqual({
      id: 'gen-1',
      predictionId: 'pred-1',
      status: 'waiting',
      createdAt: '2026-10-31T09:10:02.087+00:00',
      prompt: 'A lighthouse at dawn',
      cost: 8,
      model: 'nano-banana-2',
      duration: null,
    });
  });

  it('keeps a motion run\'s duration and reads any other status as at work', async () => {
    const { client } = recordingClient({
      data: { ...ROW, status: 'processing', duration: 8, prompt: null, cost: null, model: null },
      error: null,
    });

    await expect(findCreatorActiveRun({ client, userIds: ['account-1'], tool: 'motion' })).resolves.toMatchObject({
      status: 'processing',
      duration: 8,
      prompt: null,
      cost: null,
      model: null,
    });
  });

  it('answers null when nothing of the tool is at work', async () => {
    const { client } = recordingClient({ data: null, error: null });

    await expect(findCreatorActiveRun({ client, userIds: ['account-1'], tool: 'video' })).resolves.toBeNull();
  });

  it('throws a failed read for the route to log', async () => {
    const failure = { code: '42501', message: 'permission denied for table generations' };
    const { client } = recordingClient({ data: null, error: failure });

    await expect(findCreatorActiveRun({ client, userIds: ['account-1'], tool: 'image' })).rejects.toBe(failure);
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
