import { describe, expect, it, vi } from 'vitest';

import { createStoredRows } from '@/__tests__/fixtures/stored-rows';
import {
  listOwnerGenerationsForRoute,
  OwnerGenerationsQueryError,
  projectGenerationForStudio,
  type OwnerGenerationsRouteClient,
} from '@/lib/owner-generations-route-service';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

const OWNER = 'user-1';

/** One `generations` row with every column the library route selects, so stored rows can answer each read. */
function libraryRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'generation',
    user_id: OWNER,
    output_url: null,
    showcase_asset_path: null,
    status: 'succeeded',
    created_at: '2026-10-14T08:00:00.000Z',
    completed_at: '2026-10-14T08:01:00.000Z',
    duration: null,
    cost: 8,
    model: 'nano-banana-2',
    category: 'image',
    is_public: false,
    title: null,
    description: null,
    prompt: 'private prompt',
    workflow_settings: {},
    archived_at: null,
    refunded: false,
    error_message: null,
    moderation_removed_at: null,
    template_run_id: null,
    template_run_step_id: null,
    studio_visible: true,
    preview_url: null,
    display_url: null,
    preview_thumbhash: null,
    preview_status: 'pending',
    preview_width: null,
    preview_height: null,
    creation_mode: null,
    playback_rendition_path: null,
    playback_rendition_source: null,
    playback_rendition_status: 'pending',
    source_unavailable_at: null,
    ...overrides,
  };
}

/** The owner library over rows that apply its filters, the way Postgres would. */
async function listStoredLibrary(tables: Record<string, Array<Record<string, unknown>>>, query: string) {
  const stored = createStoredRows({
    profiles: [{ id: 'someone-else', merged_into_user_id: null }],
    ...tables,
  });
  const payload = await listOwnerGenerationsForRoute({
    userId: OWNER,
    supabase: stored.client,
    getAdminSupabase: () => stored.client,
    searchParams: new URLSearchParams(query),
  });
  return { generations: payload.generations as Array<Record<string, unknown>>, reads: stored.reads };
}

type GenerationStatusRow = {
  id: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  model: string;
  category: string | null;
  template_run_id?: string | null;
  template_run_step_id?: string | null;
  studio_visible?: boolean;
};

function createStatusClient(
  rows: GenerationStatusRow[],
  options: {
    runs?: Array<{ id: string; template_id: string; result_generation_id: string | null; status: string }>;
    templates?: Array<{ id: string; name: string | null }>;
  } = {},
) {
  const selectedColumns: string[] = [];
  const filters: Array<{ column: string; value: unknown }> = [];
  const nullFilters: string[] = [];
  const orFilters: string[] = [];
  const inFilters: Array<{ column: string; values: unknown[] }> = [];
  const ranges: Array<{ from: number; to: number }> = [];

  const from = vi.fn((table: string) => {
    return {
      select(columns: string) {
        selectedColumns.push(columns);
        const query = {
          eq(column: string, value: unknown) {
            filters.push({ column, value });
            return query;
          },
          order() {
            return query;
          },
          is(column: string, value: null) {
            if (value === null) {
              nullFilters.push(column);
            }
            return query;
          },
          or(value: string) {
            orFilters.push(value);
            return query;
          },
          in(column: string, values: unknown[]) {
            inFilters.push({ column, values });
            return query;
          },
          range(fromIndex: number, toIndex: number) {
            ranges.push({ from: fromIndex, to: toIndex });
            return query;
          },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            if (table === 'template_runs') {
              resolve({ data: options.runs ?? [], error: null });
              return;
            }
            if (table === 'templates') {
              resolve({ data: options.templates ?? [], error: null });
              return;
            }
            if (table !== 'generations') {
              throw new Error(`Unexpected table: ${table}`);
            }
            const lastRange = ranges.at(-1) ?? { from: 0, to: rows.length - 1 };
            resolve({
              data: rows.slice(lastRange.from, lastRange.to + 1),
              error: null,
            });
          },
        };

        return query;
      },
    };
  });

  return {
    selectedColumns,
    filters,
    inFilters,
    nullFilters,
    orFilters,
    ranges,
    client: { from } as unknown as OwnerGenerationsRouteClient,
  };
}

describe('listOwnerGenerationsForRoute', () => {
  it('returns bounded status pages without creating an admin client', async () => {
    const ownerClient = createStatusClient([
      {
        id: 'gen-1',
        status: 'processing',
        created_at: '2026-06-22T08:00:00.000Z',
        completed_at: null,
        model: 'nano-banana-2',
        category: 'image',
      },
      {
        id: 'gen-2',
        status: 'succeeded',
        created_at: '2026-06-22T07:00:00.000Z',
        completed_at: '2026-06-22T07:01:00.000Z',
        model: 'kling-3.0-video',
        category: 'video',
      },
    ]);
    const getAdminSupabase = vi.fn(() => ownerClient.client);

    const payload = await listOwnerGenerationsForRoute({
      userId: 'user-1',
      supabase: ownerClient.client,
      getAdminSupabase,
      searchParams: new URLSearchParams('detail=status&limit=1'),
    });

    expect(ownerClient.selectedColumns).toEqual([
      // The linked-account lookup: work made before the person registered keeps
      // its guest UUID, so the owner filter has to be a set rather than an id.
      'id',
      'id, status, created_at, completed_at, model, category, archived_at, refunded, template_run_id, template_run_step_id, studio_visible',
    ]);
    expect(ownerClient.inFilters).toContainEqual({ column: 'user_id', values: ['user-1'] });
    expect(ownerClient.nullFilters).toEqual(['archived_at']);
    expect(ownerClient.orFilters).toEqual([
      'and(template_run_id.is.null,template_run_step_id.is.null),studio_visible.eq.true',
    ]);
    expect(ownerClient.ranges).toEqual([{ from: 0, to: 1 }]);
    expect(getAdminSupabase).toHaveBeenCalledOnce();
    expect(payload).toEqual({
      generations: [
        {
          id: 'gen-1',
          status: 'processing',
          created_at: '2026-06-22T08:00:00.000Z',
          completed_at: null,
          category: 'image',
          model: 'nano-banana-2',
          origin: 'creation',
          template: null,
          refunded: false,
        },
      ],
      pagination: {
        limit: 1,
        hasMore: true,
        nextCursor: '1',
      },
    });
  });

  it('filters active-status refreshes to a validated bounded id set', async () => {
    const firstId = '10000000-0000-4000-8000-000000000001';
    const secondId = '10000000-0000-4000-8000-000000000002';
    const database = createStatusClient([
      {
        id: firstId,
        status: 'processing',
        created_at: '2026-06-22T08:00:00.000Z',
        completed_at: null,
        model: 'nano-banana-2',
        category: 'image',
      },
      {
        id: secondId,
        status: 'waiting',
        created_at: '2026-06-22T07:00:00.000Z',
        completed_at: null,
        model: 'kling-3.0-video',
        category: 'video',
      },
    ]);

    const payload = await listOwnerGenerationsForRoute({
      userId: 'user-1',
      supabase: database.client,
      getAdminSupabase: () => database.client,
      searchParams: new URLSearchParams(
        `detail=status&ids=${firstId},invalid,${secondId},${firstId}`,
      ),
    });

    expect(database.inFilters).toContainEqual({
      column: 'id',
      values: [firstId, secondId],
    });
    expect(database.ranges).toEqual([{ from: 0, to: 1 }]);
    expect(payload.generations.map((generation) => generation.id)).toEqual([firstId, secondId]);
    expect(payload.pagination.hasMore).toBe(false);
  });

  it('hydrates linked guest generations, posts, and media without exposing the guest owner id', async () => {
    const inFilters: Array<{ table: string; column: string; values: unknown[] }> = [];
    const rows: Record<string, unknown[]> = {
      profiles: [{ id: 'guest-1' }],
      generations: [{
        id: 'gen-guest-1',
        user_id: 'guest-1',
        output_url: 'generated_images/guest-1/output.png',
        showcase_asset_path: null,
        status: 'succeeded',
        created_at: '2026-08-19T10:00:00.000Z',
        completed_at: '2026-08-19T10:01:00.000Z',
        duration: null,
        cost: 1,
        model: 'nano-banana-2',
        category: 'image',
        is_public: false,
        title: 'Linked guest creation',
        description: null,
        prompt: 'private prompt',
        workflow_settings: {},
        archived_at: null,
        template_run_id: null,
        template_run_step_id: null,
        studio_visible: true,
        preview_url: null,
        preview_thumbhash: null,
        preview_status: 'pending',
        creation_mode: null,
      }],
      posts: [{
        id: 'post-guest-1',
        generation_id: 'gen-guest-1',
        title: 'Linked guest post',
        visibility: 'private',
        archived_at: null,
      }],
      generation_input_media: [],
    };
    const from = vi.fn((table: string) => ({
      select: vi.fn(() => {
        const query = {
          eq: vi.fn(() => query),
          in: vi.fn((column: string, values: unknown[]) => {
            inFilters.push({ table, column, values });
            return query;
          }),
          is: vi.fn(() => query),
          or: vi.fn(() => query),
          order: vi.fn(() => query),
          range: vi.fn(() => query),
          then: (resolve: (result: { data: unknown[]; error: null }) => unknown) => (
            Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve)
          ),
        };
        return query;
      }),
    }));
    const createSignedUrls = vi.fn(async (paths: string[]) => ({
      data: paths.map((path) => ({
        path,
        signedUrl: `https://signed.example/${path}`,
        error: null,
      })),
      error: null,
    }));
    const client = {
      from,
      storage: { from: vi.fn(() => ({ createSignedUrls })) },
    } as unknown as OwnerGenerationsRouteClient;

    const payload = await listOwnerGenerationsForRoute({
      userId: 'user-1',
      supabase: client,
      getAdminSupabase: () => client,
      searchParams: new URLSearchParams('limit=10'),
    });

    expect(inFilters).toContainEqual({
      table: 'generations',
      column: 'user_id',
      values: ['user-1', 'guest-1'],
    });
    expect(inFilters).toContainEqual({
      table: 'posts',
      column: 'user_id',
      values: ['user-1', 'guest-1'],
    });
    expect(createSignedUrls).toHaveBeenCalledWith(['guest-1/output.png'], 3600);
    expect(payload.generations[0]).toMatchObject({
      id: 'gen-guest-1',
      output_url: 'https://signed.example/guest-1/output.png',
      linked_post_id: 'post-guest-1',
    });
    expect(payload.generations[0]).not.toHaveProperty('user_id');
  });

  it('withholds every address of a generation whose only source is gone', async () => {
    const rows: Record<string, unknown[]> = {
      profiles: [],
      generations: [{
        id: 'gen-gone',
        user_id: 'user-1',
        output_url: 'https://tempfile.provider.example/expired.mp4',
        showcase_asset_path: null,
        status: 'succeeded',
        created_at: '2026-03-05T10:00:00.000Z',
        completed_at: '2026-03-05T10:02:00.000Z',
        duration: 5,
        cost: 1,
        model: 'kling-2.6/motion-control',
        category: 'motion',
        is_public: false,
        title: null,
        description: null,
        prompt: 'a clip',
        workflow_settings: {},
        archived_at: null,
        template_run_id: null,
        template_run_step_id: null,
        studio_visible: true,
        preview_url: 'https://tempfile.provider.example/expired.jpg',
        preview_thumbhash: null,
        preview_status: 'failed',
        creation_mode: 'motion',
        // The 20260908061500 migration: the provider's temporary copy is gone.
        source_unavailable_at: '2026-09-08T06:15:00.000Z',
      }],
      posts: [],
      generation_input_media: [],
    };
    const from = vi.fn((table: string) => ({
      select: vi.fn(() => {
        const query = {
          eq: vi.fn(() => query),
          in: vi.fn(() => query),
          is: vi.fn(() => query),
          or: vi.fn(() => query),
          order: vi.fn(() => query),
          range: vi.fn(() => query),
          then: (resolve: (result: { data: unknown[]; error: null }) => unknown) => (
            Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve)
          ),
        };
        return query;
      }),
    }));
    const createSignedUrls = vi.fn(async (paths: string[]) => ({
      data: paths.map((path) => ({ path, signedUrl: `https://signed.example/${path}`, error: null })),
      error: null,
    }));
    const client = {
      from,
      storage: { from: vi.fn(() => ({ createSignedUrls })) },
    } as unknown as OwnerGenerationsRouteClient;

    const payload = await listOwnerGenerationsForRoute({
      userId: 'user-1',
      supabase: client,
      getAdminSupabase: () => client,
      searchParams: new URLSearchParams('limit=10'),
    });

    expect(payload.generations).toHaveLength(1);
    const [generation] = payload.generations as Array<Record<string, unknown>>;
    expect(generation).toMatchObject({
      id: 'gen-gone',
      status: 'succeeded',
      media: null,
      preview_url: null,
      source_unavailable_at: '2026-09-08T06:15:00.000Z',
    });
    expect(generation).not.toHaveProperty('output_url');
    expect(generation).not.toHaveProperty('output_urls');
  });

  it('rejects an ids filter with no valid identifiers before querying', async () => {
    const database = createStatusClient([]);
    const getAdminSupabase = vi.fn(() => database.client);

    await expect(listOwnerGenerationsForRoute({
      userId: 'user-1',
      supabase: database.client,
      getAdminSupabase,
      searchParams: new URLSearchParams('detail=status&ids=invalid,also-invalid'),
    })).resolves.toEqual({
      generations: [],
      pagination: {
        limit: 80,
        hasMore: false,
        nextCursor: null,
      },
    });

    expect(getAdminSupabase).not.toHaveBeenCalled();
  });

  it('returns only an owned canonical non-test template result', async () => {
    const database = createStatusClient([
      {
        id: 'ordinary-1',
        status: 'processing',
        created_at: '2026-07-12T10:03:00.000Z',
        completed_at: null,
        model: 'nano-banana-2',
        category: 'image',
        template_run_id: null,
        template_run_step_id: null,
        studio_visible: true,
      },
      {
        id: 'final-1',
        status: 'succeeded',
        created_at: '2026-07-12T10:02:00.000Z',
        completed_at: '2026-07-12T10:02:30.000Z',
        model: 'nano-banana-2',
        category: 'image',
        template_run_id: 'run-1',
        template_run_step_id: 'step-final',
        studio_visible: true,
      },
      {
        id: 'intermediate-1',
        status: 'succeeded',
        created_at: '2026-07-12T10:01:00.000Z',
        completed_at: '2026-07-12T10:01:30.000Z',
        model: 'nano-banana-2',
        category: 'image',
        template_run_id: 'run-1',
        template_run_step_id: 'step-intermediate',
        studio_visible: true,
      },
      {
        id: 'test-final-1',
        status: 'succeeded',
        created_at: '2026-07-12T10:00:00.000Z',
        completed_at: '2026-07-12T10:00:30.000Z',
        model: 'nano-banana-2',
        category: 'image',
        template_run_id: 'test-run-1',
        template_run_step_id: 'test-step-final',
        studio_visible: true,
      },
    ], {
      runs: [{ id: 'run-1', template_id: 'template-1', result_generation_id: 'final-1', status: 'succeeded' }],
      templates: [{ id: 'template-1', name: 'Ghost rider transformation' }],
    });

    const payload = await listOwnerGenerationsForRoute({
      userId: 'user-1',
      supabase: database.client,
      getAdminSupabase: () => database.client,
      searchParams: new URLSearchParams('detail=status'),
    });

    expect(payload.generations.map((generation) => generation.id)).toEqual([
      'ordinary-1',
      'final-1',
    ]);
    expect(payload.generations[1]).toMatchObject({
      origin: 'template',
      model: 'template-workflow',
      template: {
        runId: 'run-1',
        templateId: 'template-1',
        templateTitle: 'Ghost rider transformation',
        runStatus: 'succeeded',
      },
    });
  });

  it('lists the finished steps of a cancelled or failed run with how the run ended, and never a test run', async () => {
    const step = (id: string, run: string, overrides: Record<string, unknown> = {}) => libraryRow({
      id,
      template_run_id: run,
      template_run_step_id: `${id}-step`,
      ...overrides,
    });
    const run = (id: string, status: string, overrides: Record<string, unknown> = {}) => ({
      id,
      user_id: OWNER,
      template_id: 'template-1',
      status,
      is_test: false,
      result_generation_id: null,
      ...overrides,
    });
    const tables = {
      generations: [
        step('cancelled-step', 'run-cancelled'),
        // The run's ending makes only finished steps studio-visible.
        step('cancelled-hidden', 'run-cancelled', { studio_visible: false }),
        step('cancelled-failed', 'run-cancelled', { status: 'failed' }),
        step('failed-run-step', 'run-failed'),
        step('test-run-step', 'run-test'),
        step('running-step', 'run-running'),
        step('succeeded-intermediate', 'run-succeeded'),
        step('succeeded-result', 'run-succeeded'),
      ],
      template_runs: [
        run('run-cancelled', 'cancelled'),
        run('run-failed', 'failed'),
        // A creator's test of their own draft stays off the library however it ended.
        run('run-test', 'cancelled', { is_test: true }),
        run('run-running', 'processing'),
        run('run-succeeded', 'succeeded', { result_generation_id: 'succeeded-result' }),
      ],
      templates: [{ id: 'template-1', name: 'Ghost rider transformation' }],
      posts: [],
    };

    const status = await listStoredLibrary(tables, 'detail=status');

    expect(status.generations.map((generation) => [
      generation.id,
      (generation.template as { runStatus?: string } | null)?.runStatus,
    ])).toEqual([
      ['cancelled-step', 'cancelled'],
      ['failed-run-step', 'failed'],
      ['succeeded-result', 'succeeded'],
    ]);
    expect(status.generations[0]).toMatchObject({
      origin: 'template',
      model: 'template-workflow',
      template: {
        runId: 'run-cancelled',
        templateId: 'template-1',
        templateTitle: 'Ghost rider transformation',
        runStatus: 'cancelled',
      },
    });
    expect(status.reads).toContainEqual({
      table: 'template_runs',
      columns: ['id', 'template_id', 'result_generation_id', 'status'],
    });

    // The library read keeps the template's recipe private for these steps too.
    const library = await listStoredLibrary(tables, 'detail=summary');
    expect(library.generations.map((generation) => generation.id)).toEqual([
      'cancelled-step',
      'failed-run-step',
      'succeeded-result',
    ]);
    expect(library.generations[0]).toMatchObject({
      origin: 'template',
      model: 'template-workflow',
      template: { runId: 'run-cancelled', runStatus: 'cancelled' },
    });
    expect(library.generations[0]).not.toHaveProperty('prompt');
  });

  it('sends what a failed run gave back and why, and a removal by moderation', async () => {
    const { generations } = await listStoredLibrary({
      generations: [
        libraryRow({
          id: 'refunded-failure',
          status: 'failed',
          cost: 40,
          refunded: true,
          completed_at: null,
          error_message: '  This model would not accept the reference image.  ',
        }),
        // A row from before the column had a default, and a blank reason.
        libraryRow({ id: 'kept-failure', status: 'failed', cost: 12, refunded: null, error_message: '   ' }),
        libraryRow({
          id: 'removed',
          archived_at: '2026-10-01T09:00:00.000Z',
          moderation_removed_at: '2026-10-01T09:00:00.000Z',
          // A finished creation has no failure to explain.
          error_message: 'An earlier attempt failed.',
        }),
      ],
      posts: [],
    }, 'detail=summary&includeArchived=true');

    expect(generations.map(({ id, cost, refunded, error_message, moderation_removed_at }) => ({
      id, cost, refunded, error_message, moderation_removed_at,
    }))).toEqual([
      {
        id: 'refunded-failure',
        cost: 40,
        refunded: true,
        error_message: 'This model would not accept the reference image.',
        moderation_removed_at: null,
      },
      { id: 'kept-failure', cost: 12, refunded: false, error_message: null, moderation_removed_at: null },
      { id: 'removed', cost: 8, refunded: false, error_message: null, moderation_removed_at: '2026-10-01T09:00:00.000Z' },
    ]);
    // The shape the contract's `failed-video-1` example documents.
    expect(generations[0]).toMatchObject({ output_url: null, preview_url: null, media: null });
  });

  it('tells a status poll whether a failed run gave its credits back', async () => {
    const { generations } = await listStoredLibrary({
      generations: [
        libraryRow({ id: 'refunded-failure', status: 'failed', refunded: true }),
        libraryRow({ id: 'kept-failure', status: 'failed', refunded: null }),
      ],
    }, 'detail=status');

    expect(generations.map(({ id, refunded }) => ({ id, refunded }))).toEqual([
      { id: 'refunded-failure', refunded: true },
      { id: 'kept-failure', refunded: false },
    ]);
  });

  describe('status=failed', () => {
    // Newest first, as the route orders them: failures between successes, an
    // archived one, a failed template step and a run still rendering.
    const library = [
      libraryRow({ id: 'made-1', created_at: '2026-10-14T08:09:00.000Z' }),
      libraryRow({ id: 'failed-1', status: 'failed', created_at: '2026-10-14T08:08:00.000Z' }),
      libraryRow({ id: 'made-2', created_at: '2026-10-14T08:07:00.000Z' }),
      libraryRow({
        id: 'failed-archived',
        status: 'failed',
        archived_at: '2026-10-14T09:00:00.000Z',
        created_at: '2026-10-14T08:06:00.000Z',
      }),
      libraryRow({
        id: 'failed-step',
        status: 'failed',
        template_run_id: 'run-1',
        template_run_step_id: 'step-1',
        studio_visible: true,
        created_at: '2026-10-14T08:05:00.000Z',
      }),
      libraryRow({ id: 'rendering', status: 'processing', created_at: '2026-10-14T08:04:00.000Z' }),
      libraryRow({ id: 'failed-2', status: 'failed', created_at: '2026-10-14T08:03:00.000Z' }),
      libraryRow({ id: 'failed-3', status: 'failed', created_at: '2026-10-14T08:02:00.000Z' }),
    ];

    async function listPage(query: string) {
      const stored = createStoredRows({
        profiles: [{ id: 'someone-else', merged_into_user_id: null }],
        generations: library,
        // The template step's run is not the owner's to list, so the projection drops it.
        template_runs: [],
        posts: [],
      });
      const payload = await listOwnerGenerationsForRoute({
        userId: OWNER,
        supabase: stored.client,
        getAdminSupabase: () => stored.client,
        searchParams: new URLSearchParams(query),
      });
      return { ids: payload.generations.map((generation) => generation.id), pagination: payload.pagination };
    }

    it('cuts each page from the unarchived failed runs alone', async () => {
      await expect(listPage('detail=summary&status=failed&limit=2')).resolves.toEqual({
        ids: ['failed-1', 'failed-2'],
        pagination: { limit: 2, hasMore: true, nextCursor: '2' },
      });
      await expect(listPage('detail=summary&status=failed&limit=2&cursor=2')).resolves.toEqual({
        ids: ['failed-3'],
        pagination: { limit: 2, hasMore: false, nextCursor: null },
      });
    });

    it('takes archived failures only when asked for archived runs, and never a template step', async () => {
      await expect(listPage('detail=summary&status=failed&includeArchived=true')).resolves.toMatchObject({
        ids: ['failed-1', 'failed-archived', 'failed-2', 'failed-3'],
      });
    });

    it('narrows the status poll the same way', async () => {
      await expect(listPage('detail=status&status=failed')).resolves.toMatchObject({
        ids: ['failed-1', 'failed-2', 'failed-3'],
      });
    });

    it('leaves the library unfiltered without it', async () => {
      await expect(listPage('detail=summary')).resolves.toMatchObject({
        ids: ['made-1', 'failed-1', 'made-2', 'rendering', 'failed-2', 'failed-3'],
      });
    });

    it('refuses any other status before reading anything', async () => {
      const stored = createStoredRows({ generations: library });
      const getAdminSupabase = vi.fn(() => stored.client);

      await expect(listOwnerGenerationsForRoute({
        userId: OWNER,
        supabase: stored.client,
        getAdminSupabase,
        searchParams: new URLSearchParams('status=succeeded'),
      })).rejects.toBeInstanceOf(OwnerGenerationsQueryError);
      expect(getAdminSupabase).not.toHaveBeenCalled();
      expect(stored.reads).toEqual([]);
    });
  });

  it('sends the bundle a linked post sells, read once for the page', async () => {
    const post = (id: string, generationId: string) => ({
      id,
      user_id: OWNER,
      generation_id: generationId,
      title: id,
      visibility: 'public',
      archived_at: null,
    });
    const { generations, reads } = await listStoredLibrary({
      generations: [
        libraryRow({ id: 'sold' }),
        libraryRow({ id: 'retired' }),
        libraryRow({ id: 'plain' }),
        libraryRow({ id: 'unposted' }),
      ],
      posts: [post('post-sold', 'sold'), post('post-retired', 'retired'), post('post-plain', 'plain')],
      post_resource_bundles: [
        { post_id: 'post-sold', access_mode: 'paid', status: 'published', price_usd_cents: 900, retired_at: null },
        // Removed by its creator after a sale: kept for the buyers as a draft.
        { post_id: 'post-retired', access_mode: 'paid', status: 'draft', price_usd_cents: 500, retired_at: '2026-10-02T00:00:00.000Z' },
        { post_id: 'post-elsewhere', access_mode: 'free', status: 'published', price_usd_cents: 0, retired_at: null },
      ],
    }, 'detail=summary');

    expect(generations.map(({ id, linked_post_id, linked_post_bundle }) => ({ id, linked_post_id, linked_post_bundle }))).toEqual([
      {
        id: 'sold',
        linked_post_id: 'post-sold',
        linked_post_bundle: { accessMode: 'paid', status: 'published', priceUsdCents: 900 },
      },
      {
        id: 'retired',
        linked_post_id: 'post-retired',
        linked_post_bundle: { accessMode: 'paid', status: 'draft', priceUsdCents: 500 },
      },
      { id: 'plain', linked_post_id: 'post-plain', linked_post_bundle: null },
      { id: 'unposted', linked_post_id: null, linked_post_bundle: null },
    ]);
    expect(reads.filter((read) => read.table === 'post_resource_bundles')).toEqual([
      { table: 'post_resource_bundles', columns: ['post_id', 'access_mode', 'status', 'price_usd_cents'] },
    ]);
  });

  it('carries the same fields on the full read', async () => {
    const rows: Record<string, unknown[]> = {
      profiles: [],
      generations: [
        libraryRow({ id: 'refunded-failure', status: 'failed', cost: 40, refunded: true, error_message: 'Provider refused.' }),
        libraryRow({ id: 'posted' }),
      ],
      posts: [{ id: 'post-1', generation_id: 'posted', title: 'Post', visibility: 'private', archived_at: null }],
      post_resource_bundles: [{ post_id: 'post-1', access_mode: 'free', status: 'draft', price_usd_cents: 0 }],
      generation_input_media: [],
    };
    const from = vi.fn((table: string) => ({
      select: vi.fn(() => {
        const query = {
          eq: vi.fn(() => query),
          in: vi.fn(() => query),
          is: vi.fn(() => query),
          or: vi.fn(() => query),
          order: vi.fn(() => query),
          range: vi.fn(() => query),
          then: (resolve: (result: { data: unknown[]; error: null }) => unknown) => (
            Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve)
          ),
        };
        return query;
      }),
    }));
    const client = { from } as unknown as OwnerGenerationsRouteClient;

    const payload = await listOwnerGenerationsForRoute({
      userId: OWNER,
      supabase: client,
      getAdminSupabase: () => client,
      searchParams: new URLSearchParams('limit=10'),
    });

    expect(payload.generations).toEqual([
      expect.objectContaining({
        id: 'refunded-failure',
        refunded: true,
        error_message: 'Provider refused.',
        moderation_removed_at: null,
        linked_post_bundle: null,
      }),
      expect.objectContaining({
        id: 'posted',
        refunded: false,
        error_message: null,
        linked_post_bundle: { accessMode: 'free', status: 'draft', priceUsdCents: 0 },
      }),
    ]);
  });

  it('sends each field the shared contract documents for a creation', async () => {
    const added = ['refunded', 'error_message', 'moderation_removed_at', 'linked_post_bundle'];
    for (const example of mobileApiContract.endpoints.listGenerations.response.generations) {
      for (const key of added) expect(example, `contract example ${example.id} lacks "${key}"`).toHaveProperty(key);
    }

    const { generations } = await listStoredLibrary({ generations: [libraryRow({})], posts: [] }, 'detail=summary');
    for (const key of added) expect(generations[0], `route payload is missing "${key}"`).toHaveProperty(key);
  });

  it("answers the contract's failed-only query with the failed runs alone, paged as it pins", async () => {
    const variant = mobileApiContract.endpoints.listGenerations.responseVariants.failedOnly;
    const example = variant.response.generations[0];
    const stored = createStoredRows({
      profiles: [{ id: 'someone-else', merged_into_user_id: null }],
      generations: [
        libraryRow({ id: 'made-after', created_at: '2026-10-13T10:00:00.000Z' }),
        libraryRow({
          id: example.id,
          status: example.status,
          category: example.category,
          created_at: example.created_at,
          error_message: example.error_message,
          refunded: example.refunded,
        }),
        libraryRow({ id: 'made-before', created_at: '2026-10-13T08:00:00.000Z' }),
      ],
      posts: [],
    });

    const payload = await listOwnerGenerationsForRoute({
      userId: OWNER,
      supabase: stored.client,
      getAdminSupabase: () => stored.client,
      searchParams: new URLSearchParams(variant.query),
    });

    expect(payload.generations.map(({ id, status, archived_at }) => ({ id, status, archived_at }))).toEqual(
      variant.response.generations.map(({ id, status, archived_at }) => ({ id, status, archived_at })),
    );
    expect(payload.pagination).toEqual(variant.response.pagination);
  });

  it('removes private template fields from the Studio projection', () => {
    expect(projectGenerationForStudio({
      id: 'final-1',
      output_url: 'generated_images/user-1/final.jpg',
      status: 'succeeded',
      created_at: '2026-07-12T10:00:00.000Z',
      model: 'nano-banana-2',
      prompt: 'private transformation recipe',
      workflow_settings: { graph: 'private' },
      template_run_id: 'run-1',
      template_run_step_id: 'step-1',
      studio_visible: true,
    }, true)).not.toHaveProperty('prompt');
    expect(projectGenerationForStudio({
      id: 'final-1',
      output_url: 'generated_images/user-1/final.jpg',
      status: 'succeeded',
      created_at: '2026-07-12T10:00:00.000Z',
      model: 'nano-banana-2',
      prompt: 'private transformation recipe',
      workflow_settings: { graph: 'private' },
      template_run_id: 'run-1',
      template_run_step_id: 'step-1',
      studio_visible: true,
    }, true)).toMatchObject({
      id: 'final-1',
      output_url: 'generated_images/user-1/final.jpg',
    });
    const projected = projectGenerationForStudio({
      id: 'final-1',
      output_url: 'generated_images/user-1/final.jpg',
      status: 'succeeded',
      created_at: '2026-07-12T10:00:00.000Z',
      model: 'nano-banana-2',
      prompt: 'private transformation recipe',
      workflow_settings: { graph: 'private' },
      template_run_id: 'run-1',
      template_run_step_id: 'step-1',
      studio_visible: true,
    }, true);
    expect(projected).not.toHaveProperty('workflow_settings');
    expect(projected).not.toHaveProperty('template_run_step_id');
    expect(projected).not.toHaveProperty('studio_visible');
    expect(projected.model).toBe('template-workflow');
  });
});
