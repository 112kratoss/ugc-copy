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
  rowsAtDelete,
  deleteError = null,
  removeError = null,
}: {
  mediaRows?: MediaRow[];
  /** The rows as the delete finds them, when a sweep recorded on one after the read. */
  rowsAtDelete?: MediaRow[];
  deleteError?: { message: string } | null;
  removeError?: { message: string } | null;
} = {}) {
  const deletedIds: string[][] = [];
  const removals: string[][] = [];
  const queued: unknown[] = [];
  const client = {
    rpc: async (name: string, args: unknown) => {
      if (name !== 'queue_unrecorded_showcase_media') throw new Error(`unexpected rpc ${name}`);
      queued.push(args);
      return { data: 1, error: null };
    },
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
            in: (_column: string, ids: string[]) => ({
              // The deleted rows, as `.select()` answers them.
              select: async () => {
                deletedIds.push(ids);
                if (deleteError) return { data: null, error: deleteError };
                return { data: (rowsAtDelete ?? mediaRows).filter((row) => ids.includes(row.id)), error: null };
              },
            }),
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
          exists: async () => ({ data: false, error: { status: 404 } }),
        };
      },
    },
  };
  return { client: client as never, deletedIds, removals, queued };
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

  it('queues what a sweep recorded on a row between the read and the delete, and nothing already removed', async () => {
    const { removeGenerationShowcaseDerivative } = await import('@/lib/generation-post-media');
    const row = { id: 'media-row-1', storage_path: 'showcase/gen-1/generated_abc.jpg', preview_storage_path: null };
    const { client, removals, queued } = createAdminClient({
      mediaRows: [row],
      rowsAtDelete: [{ ...row, preview_storage_path: 'showcase/gen-1/generated_abc.preview.late.webp' }],
    });

    const result = await removeGenerationShowcaseDerivative({
      adminSupabase: client,
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.jpg',
      postId: 'post-1',
    });

    expect(result).toEqual({ removed: true, removedPaths: ['showcase/gen-1/generated_abc.jpg'], removedMediaRows: 1, error: null });
    expect(removals).toEqual([['showcase/gen-1/generated_abc.jpg']]);
    expect(queued).toEqual([{ p_paths: ['showcase/gen-1/generated_abc.preview.late.webp'] }]);
  });

  it('retains the media inventory when final row cleanup fails after verified removal', async () => {
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

    expect(result).toEqual({ removed: false, removedPaths: ['showcase/gen-1/generated_abc.jpg'], removedMediaRows: 0, error: { message: 'delete rejected' } });
    expect(removals).toEqual([['showcase/gen-1/generated_abc.jpg']]);
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
  preview_storage_path?: string | null;
  display_storage_path?: string | null;
  rendition_storage_path?: string | null;
  teaser_storage_path?: string | null;
};

function createCoverMediaClient({
  rows = [],
  selectError = null,
  insertError = null,
  updateError = null,
  removeError = null,
  generation = null,
  generationError = null,
}: {
  rows?: CoverRow[];
  selectError?: { message: string } | null;
  insertError?: { message?: string; code?: string } | null;
  updateError?: { message: string } | null;
  removeError?: { message: string } | null;
  generation?: { preview_width: number | null; preview_height: number | null } | null;
  generationError?: { message: string } | null;
} = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; values: Record<string, unknown> }> = [];
  const removals: string[][] = [];
  const generationReads: Array<{ columns: string; column: string; id: string }> = [];
  const client = {
    from(table: string) {
      if (table === 'generations') {
        return {
          select(columns: string) {
            return {
              eq(column: string, id: string) {
                return {
                  maybeSingle: async () => {
                    generationReads.push({ columns, column, id });
                    return { data: generationError ? null : generation, error: generationError };
                  },
                };
              },
            };
          },
        };
      }
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
  return { client: client as never, inserts, updates, removals, generationReads };
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
      // A row the June 2026 gallery backfill left pointing at the private
      // original must not keep both locations.
      external_url: null,
      // A sweep still working on the old file finishes with a write
      // conditioned on holding the lease; releasing it makes that write miss.
      preview_locked_at: null,
      preview_locked_by: null,
      rendition_locked_at: null,
      rendition_locked_by: null,
      teaser_locked_at: null,
      teaser_locked_by: null,
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

  it('retires the superseded object and every derivative built from it once the row has moved', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client, updates, removals } = createCoverMediaClient({
      rows: [{
        id: 'row-1',
        sort_order: 0,
        storage_path: 'showcase/gen-1/generated_old.111111111111.jpg',
        preview_storage_path: 'showcase/gen-1/generated_old.111111111111.preview.aaaa.webp',
        display_storage_path: 'showcase/gen-1/generated_old.111111111111.display.bbbb.webp',
        rendition_storage_path: null,
        // A derivative that is not this generation's must never be touched,
        // whatever column it sits in.
        teaser_storage_path: 'showcase/gen-9/stray.teaser.cccc.mp4',
      }],
    });

    const result = await ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_new.222222222222.jpg',
      category: 'image',
    });

    expect(result).toEqual({ outcome: 'repointed', error: null });
    expect(updates).toHaveLength(1);
    expect(removals).toHaveLength(1);
    expect(removals[0]).toEqual([
      'showcase/gen-1/generated_old.111111111111.jpg',
      'showcase/gen-1/generated_old.111111111111.preview.aaaa.webp',
      'showcase/gen-1/generated_old.111111111111.display.bbbb.webp',
    ]);
  });

  it('keeps the repoint when retiring the old objects fails, so a publish never fails on cleanup', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client, updates, removals } = createCoverMediaClient({
      rows: [{ id: 'row-1', storage_path: 'showcase/gen-1/generated_old.111111111111.mp4', sort_order: 0 }],
      removeError: { message: 'bucket unavailable' },
    });

    const result = await ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_new.222222222222.mp4',
      category: 'video',
    });

    expect(result).toEqual({ outcome: 'repointed', error: null });
    expect(updates).toHaveLength(1);
    expect(removals).toEqual([['showcase/gen-1/generated_old.111111111111.mp4']]);
  });

  it('removes nothing when a gallery-backfill row never had a stored path', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client, removals } = createCoverMediaClient({
      rows: [{ id: 'row-1', storage_path: null, sort_order: 0 }],
    });

    await ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_new.222222222222.jpg',
      category: 'image',
    });

    expect(removals).toEqual([]);
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

  it('adopts a gallery-backfill row that never had a stored path', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    // The June 2026 backfill wrote external_url only for posts that were
    // private then; publishing one now gives it the derivative.
    const { client, inserts, updates } = createCoverMediaClient({
      rows: [{ id: 'row-1', storage_path: null, sort_order: 0 }],
    });

    const result = await ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4',
      category: 'video',
    });

    expect(result).toEqual({ outcome: 'repointed', error: null });
    expect(inserts).toEqual([]);
    expect(updates[0].values).toMatchObject({
      storage_path: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4',
      external_url: null,
    });
  });

  it('leaves a cover row it does not own alone instead of overwriting it', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    // Position 0 held by media belonging to some other writer. Overwriting it
    // would destroy that row, and inserting would collide on sort_order.
    const { client, inserts, updates } = createCoverMediaClient({
      rows: [{ id: 'row-1', storage_path: 'posts/post-1/0/upload.jpg', sort_order: 0 }],
    });

    const result = await ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4',
      category: 'video',
    });

    expect(result).toEqual({ outcome: 'skipped', error: null });
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('reports a failed row read rather than inserting a duplicate cover', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client, inserts } = createCoverMediaClient({ selectError: { message: 'read rejected' } });

    await expect(ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4',
      category: 'video',
    })).resolves.toEqual({ outcome: 'failed', error: { message: 'read rejected' } });
    expect(inserts).toEqual([]);
  });

  it('sizes a new cover row from the generation\'s recorded preview at publish', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    // A video row is otherwise sized only once the rendition sweep has run;
    // the card needs its ratio from the start.
    const { client, inserts, generationReads } = createCoverMediaClient({
      generation: { preview_width: 405, preview_height: 720 },
    });

    const result = await ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4',
      category: 'video',
    });

    expect(result).toEqual({ outcome: 'created', error: null });
    expect(generationReads).toEqual([{ columns: 'preview_width, preview_height', column: 'id', id: 'gen-1' }]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      storage_path: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4',
      media_kind: 'video',
      width: 405,
      height: 720,
    });
  });

  it('sizes a repointed cover from the generation instead of blanking it', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client, updates } = createCoverMediaClient({
      rows: [{ id: 'row-1', storage_path: 'showcase/gen-1/generated_old.111111111111.mp4', sort_order: 0 }],
      generation: { preview_width: 720, preview_height: 405 },
    });

    const result = await ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_new.222222222222.mp4',
      category: 'video',
    });

    expect(result).toEqual({ outcome: 'repointed', error: null });
    expect(updates[0].values).toMatchObject({
      storage_path: 'showcase/gen-1/generated_new.222222222222.mp4',
      width: 720,
      height: 405,
      // The duration still describes the replaced file.
      duration_seconds: null,
    });
  });

  it('records the row without a size when the generation has none to give', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const halfSized = createCoverMediaClient({ generation: { preview_width: 405, preview_height: null } });
    const unreadable = createCoverMediaClient({ generationError: { message: 'read rejected' } });

    for (const { client, inserts } of [halfSized, unreadable]) {
      await expect(ensureGenerationPostCoverMedia({
        adminSupabase: client,
        postId: 'post-1',
        generationId: 'gen-1',
        showcaseAssetPath: 'showcase/gen-1/generated_abc.5f9c8ae3516b.png',
        category: 'image',
      })).resolves.toEqual({ outcome: 'created', error: null });
      expect(inserts).toHaveLength(1);
      expect(inserts[0]).not.toHaveProperty('width');
      expect(inserts[0]).not.toHaveProperty('height');
    }
  });

  it('reads no generation for a cover row that stays as it is', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client, generationReads } = createCoverMediaClient({
      rows: [{ id: 'row-1', storage_path: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4', sort_order: 0 }],
      generation: { preview_width: 405, preview_height: 720 },
    });

    await expect(ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_abc.348d1d89d1cf.mp4',
      category: 'video',
    })).resolves.toEqual({ outcome: 'unchanged', error: null });
    expect(generationReads).toEqual([]);
  });

  it('reports a failed repoint, the one path that can strand a row on a deleted object', async () => {
    const { ensureGenerationPostCoverMedia } = await import('@/lib/generation-post-media');
    const { client } = createCoverMediaClient({
      rows: [{ id: 'row-1', storage_path: 'showcase/gen-1/generated_old.111111111111.mp4', sort_order: 0 }],
      updateError: { message: 'update rejected' },
    });

    await expect(ensureGenerationPostCoverMedia({
      adminSupabase: client,
      postId: 'post-1',
      generationId: 'gen-1',
      showcaseAssetPath: 'showcase/gen-1/generated_new.222222222222.mp4',
      category: 'video',
    })).resolves.toEqual({ outcome: 'failed', error: { message: 'update rejected' } });
  });

});

describe('createGenerationShowcaseDerivative', () => {
  const OUTPUT = 'generated_images/user-1/generated_p1.png';

  /**
   * Storage as the copy sees it: the source's metadata, a server-side copy that
   * keeps it (or does not, or refuses), and the old download and upload.
   */
  function createStorage({
    sourceCacheControl = 'max-age=86400',
    sourceContentType = 'image/png',
    copiedCacheControl,
    copyError = null,
    existing = false,
  }: {
    sourceCacheControl?: string;
    sourceContentType?: string;
    /** What the copy ends up with, when it is not the source's. */
    copiedCacheControl?: string;
    copyError?: { message: string; statusCode?: string } | null;
    existing?: boolean;
  } = {}) {
    const calls: string[] = [];
    const objects = new Map<string, { cacheControl: string; contentType: string }>();
    if (existing) objects.set('showcase_media/showcase/gen-1/generated_p1.KEY.png', { cacheControl: 'max-age=86400', contentType: 'image/png' });
    const client = {
      storage: {
        from(bucket: string) {
          return {
            info: async (path: string) => {
              calls.push(`info ${bucket}/${path}`);
              if (bucket === 'generated_images') {
                return { data: { cacheControl: sourceCacheControl, contentType: sourceContentType, size: 7 }, error: null };
              }
              const object = objects.get(`${bucket}/${path}`);
              return object ? { data: { ...object, size: 7 }, error: null } : { data: null, error: { message: 'Object not found', statusCode: '404' } };
            },
            copy: async (from: string, to: string, options: { destinationBucket: string }) => {
              calls.push(`copy ${bucket}/${from} -> ${options.destinationBucket}/${to}`);
              if (copyError) return { data: null, error: copyError };
              const key = `${options.destinationBucket}/${to}`;
              if (objects.has(key)) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
              objects.set(key, { cacheControl: copiedCacheControl ?? sourceCacheControl, contentType: sourceContentType });
              return { data: { path: to }, error: null };
            },
            // storage-js streams a download, so the upload's type is the one the name implies.
            download: (path: string) => ({
              asStream: async () => {
                calls.push(`download ${bucket}/${path}`);
                return {
                  data: new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(new Uint8Array([1, 2, 3]));
                      controller.close();
                    },
                  }),
                  error: null,
                };
              },
            }),
            upload: async (path: string, _body: unknown, options: { cacheControl: string; contentType: string; upsert: boolean }) => {
              calls.push(`upload ${bucket}/${path} upsert=${options.upsert}`);
              objects.set(`${bucket}/${path}`, { cacheControl: `max-age=${options.cacheControl}`, contentType: options.contentType });
              return { data: { path }, error: null };
            },
            remove: async (paths: string[]) => {
              calls.push(`remove ${bucket}/${paths.join(',')}`);
              return { data: [], error: null };
            },
          };
        },
      },
    };
    return { client: client as never, calls, objects };
  }

  async function publish(storage: ReturnType<typeof createStorage>, outputUrl = OUTPUT) {
    const { createGenerationShowcaseDerivative } = await import('@/lib/generation-post-media');
    const path = await createGenerationShowcaseDerivative({
      adminSupabase: storage.client,
      category: 'image',
      generationId: 'gen-1',
      ownerUserId: 'user-1',
      outputUrl,
    });
    return path.replace(/\.[0-9a-f]{12}\./, '.KEY.');
  }

  it('copies a stored output inside Storage when it already carries the public header, reading no bytes', async () => {
    const storage = createStorage();

    await expect(publish(storage)).resolves.toBe('showcase/gen-1/generated_p1.KEY.png');

    expect(storage.calls.map((call) => call.replace(/\.[0-9a-f]{12}\./, '.KEY.'))).toEqual([
      'info generated_images/user-1/generated_p1.png',
      'copy generated_images/user-1/generated_p1.png -> showcase_media/showcase/gen-1/generated_p1.KEY.png',
      'info showcase_media/showcase/gen-1/generated_p1.KEY.png',
    ]);
    expect([...storage.objects.values()]).toEqual([{ cacheControl: 'max-age=86400', contentType: 'image/png' }]);
  });

  it('reads and writes the bytes, as before, when the source carries another header', async () => {
    const storage = createStorage({ sourceCacheControl: 'max-age=3600' });

    await publish(storage);

    expect(storage.calls.some((call) => call.startsWith('copy'))).toBe(false);
    expect(storage.calls.some((call) => call.startsWith('download generated_images/user-1/generated_p1.png'))).toBe(true);
    expect(storage.calls.find((call) => call.startsWith('upload'))).toMatch(/upsert=false$/);
    expect([...storage.objects.values()]).toEqual([{ cacheControl: 'max-age=86400', contentType: 'image/png' }]);
  });

  it('writes the bytes again over a copy whose header did not come across', async () => {
    const storage = createStorage({ copiedCacheControl: 'no-cache' });

    await publish(storage);

    expect(storage.calls.find((call) => call.startsWith('upload'))).toMatch(/upsert=true$/);
    expect([...storage.objects.values()]).toEqual([{ cacheControl: 'max-age=86400', contentType: 'image/png' }]);
  });

  it('reads and writes the bytes when the type the copy would keep is not the one the upload sets', async () => {
    const storage = createStorage({ sourceContentType: 'image/x-png' });

    await publish(storage);

    expect(storage.calls.some((call) => call.startsWith('copy'))).toBe(false);
    expect([...storage.objects.values()]).toEqual([{ cacheControl: 'max-age=86400', contentType: 'image/png' }]);
  });

  it('takes a copy already there as published, as the upload did', async () => {
    const { createGenerationShowcaseDerivative } = await import('@/lib/generation-post-media');
    const storage = createStorage();
    const first = await createGenerationShowcaseDerivative({
      adminSupabase: storage.client, category: 'image', generationId: 'gen-1', ownerUserId: 'user-1', outputUrl: OUTPUT,
    });
    storage.calls.length = 0;

    await expect(createGenerationShowcaseDerivative({
      adminSupabase: storage.client, category: 'image', generationId: 'gen-1', ownerUserId: 'user-1', outputUrl: OUTPUT,
    })).resolves.toBe(first);
    expect(storage.calls.filter((call) => call.startsWith('download') || call.startsWith('upload'))).toEqual([]);
  });

  it('reads and writes the bytes when the copy is refused', async () => {
    const storage = createStorage({ copyError: { message: 'copy unavailable', statusCode: '500' } });

    await publish(storage);

    expect(storage.calls.some((call) => call.startsWith('download'))).toBe(true);
    expect([...storage.objects.values()]).toEqual([{ cacheControl: 'max-age=86400', contentType: 'image/png' }]);
  });
});
