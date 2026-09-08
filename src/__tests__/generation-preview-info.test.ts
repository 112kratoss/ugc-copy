import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadGenerationPreviewInfoMap } from '@/lib/generation-preview-info';

/**
 * Signing a generation's private preview mints a fresh token every time, and
 * the token is part of the CDN cache key — so every signature is a guaranteed
 * miss. This map is loaded for every generation-backed post on a page, but the
 * preview is only ever used to graft a poster onto a cover that has none.
 * These tests pin that the signature follows the need.
 */
function createAdminClient(rows: Array<Record<string, unknown>>) {
  const signedPaths: string[] = [];
  const client = {
    from(table: string) {
      if (table !== 'generations') throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          in: async () => ({ data: rows, error: null }),
        }),
      };
    },
    storage: {
      from() {
        return {
          createSignedUrl: async (filePath: string) => {
            signedPaths.push(filePath);
            return { data: { signedUrl: `https://storage.test/${filePath}?token=fresh` }, error: null };
          },
        };
      },
    },
  };
  return { client: client as unknown as SupabaseClient, signedPaths };
}

const generationRow = (id: string) => ({
  id,
  user_id: 'user-1',
  model: 'nano-banana-2',
  preview_url: `generated_images/user-1/${id}.preview.webp`,
  preview_width: 720,
  preview_height: 1280,
  category: 'image',
});

describe('loadGenerationPreviewInfoMap', () => {
  it('signs every preview when no caller opinion is given', async () => {
    const { client, signedPaths } = createAdminClient([generationRow('gen-1'), generationRow('gen-2')]);

    const map = await loadGenerationPreviewInfoMap(client, ['gen-1', 'gen-2']);

    expect(signedPaths).toHaveLength(2);
    expect(map.get('gen-1')?.previewUrl).toContain('token=fresh');
    expect(map.get('gen-2')?.previewUrl).toContain('token=fresh');
  });

  it('skips the signature for a cover that already has a public poster', async () => {
    const { client, signedPaths } = createAdminClient([generationRow('gen-1'), generationRow('gen-2')]);

    const map = await loadGenerationPreviewInfoMap(client, ['gen-1', 'gen-2'], {
      signPreviewFor: Promise.resolve(new Set(['gen-1'])),
    });

    // The bucket is selected by `storage.from`, so only the path within it is
    // signed.
    expect(signedPaths).toEqual(['user-1/gen-1.preview.webp']);
    expect(map.get('gen-1')?.previewUrl).toContain('token=fresh');
    expect(map.get('gen-2')?.previewUrl).toBeNull();
  });

  it('still reports the model for a generation whose preview was not signed', async () => {
    // Callers read the model for every generation-backed post whether or not a
    // poster is grafted; dropping it would relabel posts as "external".
    const { client } = createAdminClient([generationRow('gen-1')]);

    const map = await loadGenerationPreviewInfoMap(client, ['gen-1'], {
      signPreviewFor: Promise.resolve(new Set<string>()),
    });

    expect(map.get('gen-1')).toMatchObject({
      model: 'nano-banana-2',
      previewUrl: null,
      previewWidth: 720,
      previewHeight: 1280,
    });
  });

  it('does not read the generations table at all for an empty id list', async () => {
    const from = vi.fn();
    const map = await loadGenerationPreviewInfoMap({ from } as unknown as SupabaseClient, []);

    expect(map.size).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });

  it('reads the generations table without waiting on the caller\'s set', async () => {
    // Only the signing depends on the caller's post_media read. The feed calls
    // this once per scan batch, so making the row fetch wait would cost a
    // round trip per batch.
    const { client, signedPaths } = createAdminClient([generationRow('gen-1')]);
    let selectStarted = false;
    const originalFrom = client.from.bind(client);
    (client as unknown as { from: (table: string) => unknown }).from = (table: string) => {
      selectStarted = true;
      return originalFrom(table) as unknown;
    };

    let releaseSet: (value: ReadonlySet<string>) => void = () => {};
    const signPreviewFor = new Promise<ReadonlySet<string>>((resolve) => { releaseSet = resolve; });
    const pending = loadGenerationPreviewInfoMap(client, ['gen-1'], { signPreviewFor });

    // Let the row read run while the set is still unresolved.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(selectStarted).toBe(true);
    expect(signedPaths).toEqual([]);

    releaseSet(new Set(['gen-1']));
    const map = await pending;
    expect(signedPaths).toEqual(['user-1/gen-1.preview.webp']);
    expect(map.get('gen-1')?.previewUrl).toContain('token=fresh');
  });

});
