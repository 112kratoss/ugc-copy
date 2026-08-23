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
