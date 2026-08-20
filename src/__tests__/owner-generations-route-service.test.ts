import { describe, expect, it, vi } from 'vitest';

import {
  listOwnerGenerationsForRoute,
  projectGenerationForStudio,
  type OwnerGenerationsRouteClient,
} from '@/lib/owner-generations-route-service';

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
    runs?: Array<{ id: string; template_id: string; result_generation_id: string }>;
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
      'id, status, created_at, completed_at, model, category, archived_at, template_run_id, template_run_step_id, studio_visible',
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
      runs: [{ id: 'run-1', template_id: 'template-1', result_generation_id: 'final-1' }],
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
      },
    });
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
