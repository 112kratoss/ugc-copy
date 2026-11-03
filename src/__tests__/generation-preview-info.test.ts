import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { loadGenerationPreviewInfoMap } from '@/lib/generation-preview-info';
import {
  PUBLIC_GENERATION_SETUP_PATHS,
  loadPublicGenerationSetupCatalog,
} from '@/lib/public-generation-setup';
import { postgrestSelect } from './fixtures/postgrest-select';

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

  // A template's recipe and model are its author's: Studio shows the result's
  // model as `template-workflow`, and every card read from here said the real one.
  it("reports a template result's model as Studio does, reading the run it came from", async () => {
    const { client } = createAdminClient([
      { ...generationRow('gen-run'), model: 'nano-banana-pro', template_run_id: 'run-1', template_run_step_id: null },
      { ...generationRow('gen-step'), model: 'nano-banana-pro', template_run_id: null, template_run_step_id: 'step-1' },
      { ...generationRow('gen-1'), template_run_id: null, template_run_step_id: null },
    ]);
    let columns = '';
    const originalFrom = client.from.bind(client);
    (client as unknown as { from: (table: string) => unknown }).from = (table: string) => {
      const query = originalFrom(table) as { select: (selected: string) => unknown };
      return { select: (selected: string) => { columns = selected; return query.select(selected); } };
    };

    const map = await loadGenerationPreviewInfoMap(client, ['gen-run', 'gen-step', 'gen-1']);

    expect(columns).toContain('template_run_id, template_run_step_id');
    expect(map.get('gen-run')?.model).toBe('template-workflow');
    expect(map.get('gen-step')?.model).toBe('template-workflow');
    expect(map.get('gen-1')?.model).toBe('nano-banana-2');
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

  // A post's line (the settings its creator chose, owner 2026-11-03) comes from this read, which
  // already holds every card's creation: the feed and the read by id ask for it, with no read of
  // their own, and it selects the settings' paths, never the whole record.
  describe("a card's line, from the same read", () => {
    const stored = {
      ...generationRow('gen-1'),
      template_run_id: null,
      template_run_step_id: null,
      workflow_settings: {
        model: 'nano-banana-2',
        aspectRatio: '9:16',
        resolution: '2K',
        outputFormat: 'png',
        googleSearch: false,
        compiledPrompt: 'Everything the creator typed',
      },
    };

    function answeringSelects(rows: Array<Record<string, unknown>>, refuse: (select: string) => boolean = () => false) {
      const selects: string[] = [];
      const client = {
        from(table: string) {
          if (table !== 'generations') throw new Error(`unexpected table ${table}`);
          return {
            select: (select: string) => ({
              in: async () => {
                selects.push(select);
                if (refuse(select)) return { data: null, error: { code: 'PGRST100', message: 'failed to parse select parameter' } };
                return { data: rows.map((row) => postgrestSelect(row, select)), error: null };
              },
            }),
          };
        },
        storage: {
          from: () => ({ createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://storage.test/${path}` }, error: null }) }),
        },
      };
      return { client: client as unknown as SupabaseClient, selects };
    }

    it("builds each creation's line where the caller asks, in the one read", async () => {
      const { client, selects } = answeringSelects([stored]);

      const map = await loadGenerationPreviewInfoMap(client, ['gen-1'], {
        generationSetupCatalog: loadPublicGenerationSetupCatalog(),
      });

      expect(map.get('gen-1')).toMatchObject({
        model: 'nano-banana-2',
        generationSetup: [
          { label: 'Aspect ratio', value: '9:16' },
          { label: 'Resolution', value: '2K' },
          { label: 'Output format', value: 'PNG' },
        ],
      });
      expect(selects).toHaveLength(1);
      expect(selects[0]).toContain(PUBLIC_GENERATION_SETUP_PATHS);
      expect(selects[0]).not.toMatch(/workflow_settings(?!->)/);
    });

    it('reads no settings for a caller that draws no line', async () => {
      const { client, selects } = answeringSelects([stored]);

      const map = await loadGenerationPreviewInfoMap(client, ['gen-1']);

      expect(map.get('gen-1')).not.toHaveProperty('generationSetup');
      expect(selects[0]).not.toContain('workflow_settings');
    });

    // The posters and models come from the same read, so a refusal of the paths costs the cards
    // their line, which is then unknown, and nothing else.
    it("keeps the cards' models and posters where the paths are refused, the line left unknown", async () => {
      const { client, selects } = answeringSelects([stored], (select) => select.includes('workflow_settings'));

      const map = await loadGenerationPreviewInfoMap(client, ['gen-1'], {
        generationSetupCatalog: loadPublicGenerationSetupCatalog(),
      });

      expect(selects).toHaveLength(2);
      expect(map.get('gen-1')).toMatchObject({ model: 'nano-banana-2', previewWidth: 720 });
      expect(map.get('gen-1')).not.toHaveProperty('generationSetup');
    });

    it('leaves the line unknown where the catalog cannot be read', async () => {
      const { client } = answeringSelects([stored]);

      const map = await loadGenerationPreviewInfoMap(client, ['gen-1'], {
        generationSetupCatalog: Promise.resolve(null),
      });

      expect(map.get('gen-1')?.model).toBe('nano-banana-2');
      expect(map.get('gen-1')).not.toHaveProperty('generationSetup');
    });

    it("gives a template's result no line, as it names no model", async () => {
      const { client } = answeringSelects([{ ...stored, template_run_id: 'run-1' }]);

      const map = await loadGenerationPreviewInfoMap(client, ['gen-1'], {
        generationSetupCatalog: loadPublicGenerationSetupCatalog(),
      });

      expect(map.get('gen-1')).toMatchObject({ model: 'template-workflow', generationSetup: [] });
    });
  });
});
