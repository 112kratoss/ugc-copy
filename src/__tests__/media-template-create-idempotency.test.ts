import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import {
  createMediaTemplate,
  updateMediaTemplate,
  type MediaTemplateRow,
} from '@/lib/media-template-service';

type QueryResult = { data: unknown; error: unknown };

const userId = '10000000-0000-4000-8000-000000000001';
const canvasId = '20000000-0000-4000-8000-000000000002';
const templateId = '30000000-0000-4000-8000-000000000003';

const canvas = {
  id: canvasId,
  user_id: userId,
  title: 'Workflow title',
  graph: { nodes: [], edges: [] },
  revision: 1,
};

function templateRow(overrides: Partial<MediaTemplateRow> = {}): MediaTemplateRow {
  return {
    id: templateId,
    name: 'Original draft',
    description: null,
    video_url: null,
    thumbnail_url: null,
    category: 'general',
    is_active: false,
    created_at: '2026-07-12T00:00:00.000Z',
    creator_user_id: userId,
    slug: 'original-draft',
    source_canvas_id: canvasId,
    input_slots: [],
    output_kind: null,
    status: 'draft',
    use_count: 0,
    active_version_id: null,
    draft_output_node_id: null,
    draft_catalog_revision: null,
    updated_at: '2026-07-12T00:00:00.000Z',
    ...overrides,
  };
}

function createClient(initialTemplate: MediaTemplateRow | null = null) {
  let storedTemplate = initialTemplate;
  let insertAttempts = 0;
  const pendingInserts: Array<{
    resolve: (result: QueryResult) => void;
    values: Record<string, unknown>;
  }> = [];

  const matches = (row: Record<string, unknown>, filters: Map<string, unknown>) => (
    Array.from(filters).every(([column, value]) => row[column] === value)
  );

  const from = (table: string) => {
    let operation: 'select' | 'insert' | 'update' = 'select';
    let selectedColumns = '';
    let values: Record<string, unknown> = {};
    const filters = new Map<string, unknown>();

    const execute = async (single: boolean): Promise<QueryResult> => {
      if (table === 'workflow_canvases') {
        const found = matches(canvas, filters) ? canvas : null;
        return { data: single ? found : found ? [found] : [], error: null };
      }
      if (table === 'profiles' || table === 'template_versions') {
        return { data: single ? null : [], error: null };
      }
      if (table !== 'templates') return { data: single ? null : [], error: null };

      if (operation === 'update') {
        if (!storedTemplate || !matches(storedTemplate as unknown as Record<string, unknown>, filters)) {
          return { data: null, error: { code: 'PGRST116', message: 'No row found' } };
        }
        storedTemplate = templateRow({ ...storedTemplate, ...values });
        return { data: storedTemplate, error: null };
      }

      if (operation === 'insert') {
        insertAttempts += 1;
        return new Promise<QueryResult>((resolve) => {
          pendingInserts.push({ resolve, values });
          if (pendingInserts.length !== 2) return;
          const [winner, replay] = pendingInserts;
          storedTemplate = templateRow(winner!.values as Partial<MediaTemplateRow>);
          winner!.resolve({ data: storedTemplate, error: null });
          replay!.resolve({
            data: null,
            error: {
              code: '23505',
              message: 'duplicate key value violates unique constraint',
            },
          });
        });
      }

      const found = storedTemplate
        && matches(storedTemplate as unknown as Record<string, unknown>, filters)
        ? storedTemplate
        : null;
      if (single) return { data: found, error: null };
      if (!found) return { data: [], error: null };
      return {
        data: selectedColumns === 'id' ? [{ id: found.id }] : [found],
        error: null,
      };
    };

    const query = {
      select(columns: string) {
        selectedColumns = columns;
        return query;
      },
      insert(nextValues: Record<string, unknown>) {
        operation = 'insert' as const;
        values = nextValues;
        return query;
      },
      update(nextValues: Record<string, unknown>) {
        operation = 'update' as const;
        values = nextValues;
        return query;
      },
      eq(column: string, value: unknown) {
        filters.set(column, value);
        return query;
      },
      neq() {
        return query;
      },
      limit() {
        return query;
      },
      in() {
        return query;
      },
      maybeSingle: () => execute(true),
      single: () => execute(true),
      then<TResult1 = QueryResult, TResult2 = never>(
        onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return execute(false).then(onfulfilled, onrejected);
      },
    };
    return query;
  };

  const storage = {
    from: () => ({
      createSignedUrl: async (objectPath: string) => ({
        data: { signedUrl: `https://signed.example.test/${objectPath}` },
        error: null,
      }),
    }),
  };

  return {
    client: { from, storage } as unknown as SupabaseClient,
    get insertAttempts() {
      return insertAttempts;
    },
    get storedTemplate() {
      return storedTemplate;
    },
  };
}

describe('createMediaTemplate idempotency', () => {
  it('updates and returns the existing draft for the same creator workflow', async () => {
    const database = createClient(templateRow());

    const result = await createMediaTemplate(database.client, userId, {
      sourceCanvasId: canvasId,
      name: 'Updated draft',
      description: 'Latest description',
      outputNodeId: 'output-2',
    });

    expect(result).toMatchObject({ id: templateId, name: 'Updated draft' });
    expect(database.insertAttempts).toBe(0);
    expect(database.storedTemplate).toMatchObject({
      id: templateId,
      description: 'Latest description',
      draft_output_node_id: 'output-2',
    });
  });

  it('recovers two simultaneous creates as one updated draft', async () => {
    const database = createClient();

    const [first, second] = await Promise.all([
      createMediaTemplate(database.client, userId, {
        sourceCanvasId: canvasId,
        name: 'First request',
        outputNodeId: 'output-1',
      }),
      createMediaTemplate(database.client, userId, {
        sourceCanvasId: canvasId,
        name: 'Second request',
        outputNodeId: 'output-2',
      }),
    ]);

    expect(database.insertAttempts).toBe(2);
    expect(first.id).toBe(templateId);
    expect(second.id).toBe(templateId);
    expect(database.storedTemplate).toMatchObject({
      id: templateId,
      name: 'Second request',
      draft_output_node_id: 'output-2',
    });
  });
});

describe('template thumbnails', () => {
  const refusal = {
    status: 400,
    code: 'INVALID_TEMPLATE',
    message: 'Thumbnails must be uploaded template assets.',
    fieldErrors: { thumbnailUrl: 'Thumbnails must be uploaded template assets.' },
  };
  const liveTemplate = () => templateRow({
    status: 'active',
    is_active: true,
    active_version_id: 'version-1',
    output_kind: 'image',
    thumbnail_url: `template_assets/${templateId}/version-1/demo/output.png`,
  });

  it('refuses an outside image on a live template and keeps its poster', async () => {
    const database = createClient(liveTemplate());

    await expect(updateMediaTemplate(database.client, userId, templateId, {
      thumbnailUrl: 'https://cdn.example.com/swapped-poster.png',
    })).rejects.toMatchObject(refusal);
    expect(database.storedTemplate?.thumbnail_url).toBe(`template_assets/${templateId}/version-1/demo/output.png`);
  });

  it.each([
    ['another template\'s asset', 'template_assets/40000000-0000-4000-8000-000000000004/version-1/demo/output.png'],
    ['a path that climbs out of this template', `template_assets/${templateId}/../40000000-0000-4000-8000-000000000004/poster.png`],
    ['the creator\'s own upload outside template assets', `generated_images/${userId}/poster.png`],
    ['a value that is not text', 42],
  ])('refuses %s', async (_label, thumbnailUrl) => {
    const database = createClient(liveTemplate());

    await expect(updateMediaTemplate(database.client, userId, templateId, { thumbnailUrl }))
      .rejects.toMatchObject(refusal);
    expect(database.storedTemplate?.thumbnail_url).toBe(`template_assets/${templateId}/version-1/demo/output.png`);
  });

  it('takes one of the template\'s own stored assets, or null to clear it', async () => {
    const database = createClient(liveTemplate());
    const poster = `template_assets/${templateId}/version-1/demo/poster.webp`;

    const updated = await updateMediaTemplate(database.client, userId, templateId, { thumbnailUrl: poster });
    expect(database.storedTemplate?.thumbnail_url).toBe(poster);
    expect(updated.thumbnailUrl).toBe(`https://signed.example.test/${templateId}/version-1/demo/poster.webp`);

    await updateMediaTemplate(database.client, userId, templateId, { thumbnailUrl: null });
    expect(database.storedTemplate?.thumbnail_url).toBeNull();
  });

  it('refuses any image on a template being created, before anything is written', async () => {
    const database = createClient();

    await expect(createMediaTemplate(database.client, userId, {
      sourceCanvasId: canvasId,
      name: 'Fresh template',
      thumbnailUrl: 'https://cdn.example.com/poster.png',
    })).rejects.toMatchObject(refusal);
    expect(database.insertAttempts).toBe(0);
  });
});

describe('template slugs', () => {
  it.each([
    ['live', { status: 'active', is_active: true, active_version_id: 'version-1' }],
    ['disabled', { status: 'disabled', is_active: false, active_version_id: 'version-1' }],
  ] as const)('keeps the address of a %s template when it is renamed', async (_label, state) => {
    const database = createClient(templateRow(state));

    const updated = await updateMediaTemplate(database.client, userId, templateId, { name: 'A new name' });

    expect(updated).toMatchObject({ name: 'A new name', slug: 'original-draft' });
    expect(database.storedTemplate).toMatchObject({ name: 'A new name', slug: 'original-draft' });
  });

  it('moves a draft to the slug of its new name', async () => {
    const database = createClient(templateRow());

    await updateMediaTemplate(database.client, userId, templateId, { name: 'Renamed draft' });

    expect(database.storedTemplate?.slug).toBe('renamed-draft');
  });

  it.each(['New', 'Mine', 'Create', 'Edit', 'Run', 'Runs'])(
    'never gives a draft named %s the path the web keeps for itself',
    async (name) => {
      const database = createClient(templateRow());

      await updateMediaTemplate(database.client, userId, templateId, { name });

      expect(database.storedTemplate?.slug).toBe(`${name.toLowerCase()}-2`);
    },
  );

  it('moves a draft off a reserved slug it was given before, on its next save', async () => {
    const database = createClient(templateRow({ name: 'New', slug: 'new' }));

    await updateMediaTemplate(database.client, userId, templateId, { name: 'New' });

    expect(database.storedTemplate?.slug).toBe('new-2');
  });
});
