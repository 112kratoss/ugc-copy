import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import contract from '../../contracts/template-run-media-v1.json';
import {
  createTemplateRunDatabase,
  TEMPLATE_RUN_ID,
  TEMPLATE_RUN_USER_ID,
  type TemplateRunDatabase,
} from '@/__tests__/fixtures/template-run-database';
import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import { getTemplateRun } from '@/lib/template-run-service';

// The provider key is read once, when the generation modules load.
vi.hoisted(() => {
  vi.stubEnv('KIE_AI_API_KEY', 'test-key');
});

const NOW = '2026-10-14T09:00:00.000Z';
const ORIGINAL = `generated_videos/${TEMPLATE_RUN_USER_ID}/result.mp4`;
const PLAYBACK = `generated_videos/${TEMPLATE_RUN_USER_ID}/playback/gen-1/result.mp4`;
const POSTER = `generated_videos/${TEMPLATE_RUN_USER_ID}/result.preview.webp`;

/**
 * A finished run in the shape the media contract pins: one video step, whose
 * output is the run's result, with its playback copy and poster ready.
 */
function finishedVideoRun() {
  const database = createTemplateRunDatabase();
  const snapshot = database.run.graph_snapshot as { graph: { nodes: Array<{ id: string; type: string }>; edges: unknown[] } };
  const video = snapshot.graph.nodes.find((node) => node.type === 'video-generate')!;
  snapshot.graph = { ...snapshot.graph, nodes: [video], edges: [] };
  const step = database.steps.find((candidate) => candidate.node_id === video.id)!;
  database.steps.splice(0, database.steps.length, step);
  database.generations.push({
    id: 'gen-1',
    user_id: TEMPLATE_RUN_USER_ID,
    status: 'succeeded',
    prediction_id: 'task-gen-1',
    output_url: ORIGINAL,
    error_message: null,
    cost: step.estimated_credits,
    actual_cost: step.estimated_credits,
    template_run_id: TEMPLATE_RUN_ID,
    template_run_step_id: step.id,
    studio_visible: true,
    playback_rendition_path: PLAYBACK,
    playback_rendition_source: ORIGINAL,
    playback_rendition_status: 'ready',
    preview_url: POSTER,
    preview_status: 'ready',
    created_at: NOW,
    completed_at: NOW,
  });
  Object.assign(step, { status: 'succeeded', generation_id: 'gen-1', output_url: ORIGINAL, started_at: NOW, finished_at: NOW });
  Object.assign(database.run, {
    status: 'succeeded',
    input_manifest: [],
    input_storage_paths: {},
    result_url: ORIGINAL,
    result_generation_id: 'gen-1',
    estimated_remaining_credits: 0,
    completed_at: NOW,
  });
  return database;
}

/** The run's tables, with each table a query was made on written down. */
function recordingTables(base: SupabaseClient) {
  const asked: string[] = [];
  const client = {
    ...base,
    from(table: string) {
      asked.push(table);
      return base.from(table);
    },
  } as unknown as SupabaseClient;
  return { client, asked };
}

const read = (client: SupabaseClient) => getTemplateRun({ adminClient: client, runId: TEMPLATE_RUN_ID, userId: TEMPLATE_RUN_USER_ID });

/**
 * Every field the fixture pins is on the server's answer, and a value the
 * fixture gives is of the same kind there. The server may send more: the
 * clients read the fixture, so a field it lacks breaks no client.
 */
function expectToCarry(actual: object, pinned: object) {
  expect(Object.keys(actual)).toEqual(expect.arrayContaining(Object.keys(pinned)));
  for (const [key, value] of Object.entries(pinned)) {
    if (value === null) continue;
    expect([key, typeof (actual as Record<string, unknown>)[key]]).toEqual([key, typeof value]);
  }
}

describe('the run a read answers with', () => {
  it('carries every field the media contract pins for the run, its steps and its result', async () => {
    const run = await read(finishedVideoRun().client);
    const pinned = contract.response.run;

    expectToCarry(run, pinned);
    expectToCarry(run.steps[0], pinned.steps[0]);
    expect(run.result).not.toBeNull();
    expectToCarry(run.result!, pinned.result);
  });
});

describe('the post made from a run\'s result', () => {
  let database: TemplateRunDatabase;
  let logs: BackendLogRecord[];
  let restoreLogSink: () => void;

  beforeEach(() => {
    logs = [];
    restoreLogSink = setBackendLogSink((record) => logs.push(record));
    database = finishedVideoRun();
  });
  afterEach(() => {
    restoreLogSink();
  });

  function posted(values: Record<string, unknown> = {}) {
    database.posts.push({
      id: 'post-1',
      user_id: TEMPLATE_RUN_USER_ID,
      generation_id: 'gen-1',
      visibility: 'public',
      archived_at: null,
      tombstoned_at: null,
      ...values,
    });
  }

  it('is null when the result has no post', async () => {
    const { client, asked } = recordingTables(database.client);

    const run = await read(client);

    expect(run.result?.linkedPost).toBeNull();
    expect(asked.filter((table) => table === 'posts')).toHaveLength(1);
  });

  it.each(['public', 'unlisted', 'private'] as const)('names a %s post', async (visibility) => {
    posted({ visibility });

    expect((await read(database.client)).result?.linkedPost).toEqual({ id: 'post-1', visibility });
  });

  it('reads an archived post as private, so there is nothing to share', async () => {
    posted({ archived_at: NOW });

    expect((await read(database.client)).result?.linkedPost).toEqual({ id: 'post-1', visibility: 'private' });
  });

  it('leaves out a post its owner deleted after it sold', async () => {
    // Kept for its buyers, private and archived.
    posted({ tombstoned_at: NOW, archived_at: NOW, visibility: 'private' });

    expect((await read(database.client)).result?.linkedPost).toBeNull();
  });

  it('leaves out a post that is not the owner\'s', async () => {
    posted({ user_id: 'someone-else' });

    expect((await read(database.client)).result?.linkedPost).toBeNull();
  });

  it('is not looked up for a run that has no result', async () => {
    Object.assign(database.run, { status: 'processing', result_url: null, result_generation_id: null });
    posted();
    const { client, asked } = recordingTables(database.client);

    const run = await read(client);

    expect(run.result).toBeNull();
    expect(asked).not.toContain('posts');
  });

  it('still answers with the run when the post cannot be read, and logs it', async () => {
    posted();
    const refused = { code: '57014', message: 'canceling statement due to statement timeout' };
    const unreadable = {
      select: () => unreadable,
      eq: () => unreadable,
      in: () => unreadable,
      maybeSingle: async () => ({ data: null, error: refused }),
    };
    const client = {
      ...database.client,
      from: (table: string) => (table === 'posts' ? unreadable : database.client.from(table)),
    } as unknown as SupabaseClient;

    const run = await read(client);

    expect(run.status).toBe('succeeded');
    expect(run.result).toMatchObject({ generationId: 'gen-1', linkedPost: null });
    expect(logs.filter((record) => record.msg === 'template_run_linked_post_unavailable')).toEqual([
      expect.objectContaining({ level: 'error', generationId: 'gen-1', errorMessage: refused.message }),
    ]);
  });
});
