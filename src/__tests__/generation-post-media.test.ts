import { beforeEach, describe, expect, it, vi } from 'vitest';

type MediaRow = {
  id: string;
  storage_path: string | null;
  preview_storage_path?: string | null;
  rendition_storage_path?: string | null;
  teaser_storage_path?: string | null;
};

function createAdminClient({
  mediaRows = [],
  deleteError = null,
  removeError = null,
}: {
  mediaRows?: MediaRow[];
  deleteError?: { message: string } | null;
  removeError?: { message: string } | null;
} = {}) {
  const deletedIds: string[][] = [];
  const removals: string[][] = [];
  const client = {
    from(table: string) {
      if (table !== 'post_media') throw new Error(`unexpected table ${table}`);
      return {
        select() {
          return {
            eq: async () => ({ data: mediaRows, error: null }),
          };
        },
        delete() {
          return {
            in: async (_column: string, ids: string[]) => {
              deletedIds.push(ids);
              return { error: deleteError };
            },
          };
        },
      };
    },
    storage: {
      from(bucket: string) {
        if (bucket !== 'showcase_media') throw new Error(`unexpected bucket ${bucket}`);
        return {
          remove: async (paths: string[]) => {
            removals.push(paths);
            return { data: removeError ? null : paths.map((name) => ({ name })), error: removeError };
          },
        };
      },
    },
  };
  return { client: client as never, deletedIds, removals };
}

describe('removeGenerationShowcaseDerivative', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('removes only the derivative when the post carries no media rows', async () => {
    const { removeGenerationShowcaseDerivative } = await import('@/lib/generation-post-media');
    const { client, deletedIds, removals } = createAdminClient();

    await expect(removeGenerationShowcaseDerivative({
      adminSupabase: client,
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.jpg',
      postId: 'post-1',
    })).resolves.toEqual({
      removed: true,
      removedPaths: ['showcase/gen-1/generated_abc.jpg'],
      removedMediaRows: 0,
      error: null,
    });
    expect(deletedIds).toEqual([]);
    expect(removals).toEqual([['showcase/gen-1/generated_abc.jpg']]);
  });

  it('retires a legacy media row with every public object it points at', async () => {
    const { removeGenerationShowcaseDerivative } = await import('@/lib/generation-post-media');
    const { client, deletedIds, removals } = createAdminClient({
      mediaRows: [
        {
          id: 'media-row-1',
          storage_path: 'showcase/gen-1/generated_abc.jpg',
          preview_storage_path: 'showcase/gen-1/generated_abc.preview.1234.webp',
          rendition_storage_path: null,
          teaser_storage_path: null,
        },
        // An upload the owner attached later lives under the post, not the
        // generation, and is not part of the derivative's footprint.
        {
          id: 'media-row-2',
          storage_path: 'posts/post-1/upload.jpg',
          preview_storage_path: 'posts/post-1/upload.preview.webp',
        },
      ],
    });

    const result = await removeGenerationShowcaseDerivative({
      adminSupabase: client,
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.jpg',
      postId: 'post-1',
    });

    expect(result).toEqual({
      removed: true,
      removedPaths: ['showcase/gen-1/generated_abc.jpg', 'showcase/gen-1/generated_abc.preview.1234.webp'],
      removedMediaRows: 1,
      error: null,
    });
    expect(deletedIds).toEqual([['media-row-1']]);
    expect(removals).toEqual([[
      'showcase/gen-1/generated_abc.jpg',
      'showcase/gen-1/generated_abc.preview.1234.webp',
    ]]);
  });

  it('keeps the objects when the row delete fails so the row keeps working', async () => {
    const { removeGenerationShowcaseDerivative } = await import('@/lib/generation-post-media');
    const { client, removals } = createAdminClient({
      mediaRows: [{ id: 'media-row-1', storage_path: 'showcase/gen-1/generated_abc.jpg' }],
      deleteError: { message: 'delete rejected' },
    });

    const result = await removeGenerationShowcaseDerivative({
      adminSupabase: client,
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.jpg',
      postId: 'post-1',
    });

    expect(result).toEqual({ removed: false, removedPaths: [], removedMediaRows: 0, error: { message: 'delete rejected' } });
    expect(removals).toEqual([]);
  });

  it('ignores paths outside the generation folder and skips the storage call when nothing remains', async () => {
    const { removeGenerationShowcaseDerivative } = await import('@/lib/generation-post-media');
    const { client, deletedIds, removals } = createAdminClient({
      mediaRows: [{ id: 'media-row-1', storage_path: 'showcase/other-generation/generated_abc.jpg' }],
    });

    const result = await removeGenerationShowcaseDerivative({
      adminSupabase: client,
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/other-generation/generated_abc.jpg',
      postId: 'post-1',
    });

    expect(result).toEqual({ removed: false, removedPaths: [], removedMediaRows: 0, error: null });
    expect(deletedIds).toEqual([]);
    expect(removals).toEqual([]);
  });
});

type CoverRow = {
  id: string;
  storage_path: string | null;
  sort_order: number | null;
};

function createCoverMediaClient({
  rows = [],
  selectError = null,
  insertError = null,
  updateError = null,
}: {
  rows?: CoverRow[];
  selectError?: { message: string } | null;
  insertError?: { message?: string; code?: string } | null;
  updateError?: { message: string } | null;
} = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  const client = {
    from(table: string) {
      if (table !== 'post_media') throw new Error(`unexpected table ${table}`);
      return {
        select() {
          return {
            eq: async () => ({ data: selectError ? null : rows, error: selectError }),
          };
        },
        insert: async (values: Record<string, unknown>) => {
          inserts.push(values);
          return { error: insertError };
        },
        update(values: Record<string, unknown>) {
          return {
            eq: async (_column: string, id: string) => {
              updates.push({ id, values });
              return { error: updateError };
            },
          };
        },
      };
    },
  };
  return { client: client as never, inserts, updates };
}

describe('ensureGenerationPostCoverMedia', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('records a video derivative with its rendition pending so the sweep transcodes it', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client, inserts, updates } = createCoverMediaClient();

    const result = await ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4',
      category: 'video',
    });

    expect(result).toEqual({ outcome: 'created', error: null });
    expect(updates).toEqual([]);
    expect(inserts).toEqual([{
      post_id: 'post-1',
      media_key: 'media-1',
      storage_path: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4',
      media_kind: 'video',
      content_type: 'video/mp4',
      original_name: 'generated_abc.348d1d89d1cf.mp4',
      sort_order: 0,
      preview_status: 'pending',
      preview_attempt_count: 0,
      rendition_status: 'pending',
      rendition_attempt_count: 0,
    }]);
  });

  it('marks an image rendition skipped, its terminal state', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client, inserts } = createCoverMediaClient();

    const result = await ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.5f9c8ae3516b.png',
      category: 'image',
    });

    expect(result).toEqual({ outcome: 'created', error: null });
    expect(inserts[0]).toMatchObject({
      media_kind: 'image',
      content_type: 'image/png',
      rendition_status: 'skipped',
    });
  });

  it('reads the stored file rather than the category when they disagree', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client, inserts } = createCoverMediaClient();

    // A motion generation normalises to 'video' before it reaches here, but a
    // row mislabelled 'image' must not strand an mp4 with no rendition.
    await ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4',
      category: 'image',
    });

    expect(inserts[0]).toMatchObject({ media_kind: 'video', rendition_status: 'pending' });
  });

  it('leaves a row that already serves this derivative exactly as it is', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    // Republishing after a caption edit must not discard the preview and
    // rendition the sweeps already built.
    const { client, inserts, updates } = createCoverMediaClient({
      rows: [{ id: 'row-1', storage_path: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4', sort_order: 0 }],
    });

    const result = await ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4',
      category: 'video',
    });

    expect(result).toEqual({ outcome: 'unchanged', error: null });
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('repoints a superseded cover and clears the derivatives that described the old file', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client, inserts, updates } = createCoverMediaClient({
      rows: [{ id: 'row-1', storage_path: 'showcase/gen-1/generated_old.111111111111.mp4', sort_order: 0 }],
    });

    const result = await ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_new.222222222222.mp4',
      category: 'video',
    });

    expect(result).toEqual({ outcome: 'repointed', error: null });
    expect(inserts).toEqual([]);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('row-1');
    expect(updates[0].values).toMatchObject({
      storage_path: 'showcase/gen-1/generated_new.222222222222.mp4',
      preview_storage_path: null,
      preview_status: 'pending',
      preview_attempt_count: 0,
      rendition_storage_path: null,
      rendition_status: 'pending',
      rendition_attempt_count: 0,
      teaser_storage_path: null,
      width: null,
      height: null,
      duration_seconds: null,
    });
  });

  it('refuses a path outside the generation prefix rather than adopting it', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client, inserts, updates } = createCoverMediaClient();

    const result = await ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/other-generation/generated_abc.jpg',
      category: 'image',
    });

    expect(result).toEqual({ outcome: 'skipped', error: null });
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('treats a racing publish that already inserted the row as done', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client } = createCoverMediaClient({
      insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    await expect(ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4',
      category: 'video',
    })).resolves.toEqual({ outcome: 'unchanged', error: null });
  });

  it('reports a genuine write failure instead of claiming the row exists', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client } = createCoverMediaClient({ insertError: { message: 'insert rejected' } });

    await expect(ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4',
      category: 'video',
    })).resolves.toEqual({ outcome: 'failed', error: { message: 'insert rejected' } });
  });
});
