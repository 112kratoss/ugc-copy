import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/models';
import { getPostModelDisplayName } from '@/lib/post-feed-presentation';
import { searchEntityLabel } from '@/lib/search-entity-label';

// The name search gives a model or tool, in full search's entity results and
// in the typeahead's rows. Found live on 2026-11-12: searching "kling" offered
// an entity that read "kling-2.6/motion-control".

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');

describe('the name search gives a model or tool', () => {
  it('names a motion creation’s model by the catalog, though it is stored under the provider’s id', () => {
    // The creation's model column holds the provider's id, so the database
    // keys the entity by it and has only the raw id to label it with.
    expect(MOTION_MODELS['kling-2.6'].apiModelId).toBe('kling-2.6/motion-control');
    expect(getPostModelDisplayName('kling-2.6-motion-control')).toBeNull();
    expect(searchEntityLabel({ kind: 'model', key: 'kling-2.6-motion-control', label: 'kling-2.6/motion-control' })).toBe('Kling 2.6');
    expect(searchEntityLabel({ kind: 'model', key: 'kling-3.0-motion-control', label: 'kling-3.0/motion-control' })).toBe('Kling 3.0');
    // By its key alone too: a name a post happened to print for it does not hide the catalog's.
    expect(searchEntityLabel({ kind: 'model', key: 'kling-2.6-motion-control', label: 'Motion transfer' })).toBe('Kling 2.6');
  });

  it('names every catalog model by its id and by its provider id, as the database keys them', () => {
    // public.search_entity_key: lower case, each run of characters other than letters, digits and dots a hyphen.
    const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
    const models = [IMAGE_MODELS, VIDEO_MODELS, MOTION_MODELS]
      .flatMap((catalog) => Object.values(catalog as Record<string, { id: string; displayName: string; apiModelId?: string }>));
    expect(models.length).toBeGreaterThan(40);
    const idKeys = new Map(models.map((model) => [key(model.id), model.displayName]));
    for (const model of models) {
      expect(searchEntityLabel({ kind: 'model', key: key(model.id), label: model.id }), model.id).toBe(model.displayName);
      if (!model.apiModelId) continue;
      // A provider id that keys as another model's catalog id is that model's: the catalog id outranks it.
      const expected = idKeys.get(key(model.apiModelId)) ?? model.displayName;
      expect(searchEntityLabel({ kind: 'model', key: key(model.apiModelId), label: model.apiModelId }), model.apiModelId).toBe(expected);
    }
  });

  it('keeps the name a model’s posts print when nothing here knows it, and spells a path-like id as words', () => {
    expect(searchEntityLabel({ kind: 'model', key: 'niji-6', label: 'Niji 6' })).toBe('Niji 6');
    expect(searchEntityLabel({ kind: 'model', key: 'some-outside-model', label: 'some-outside-model' })).toBe('some-outside-model');
    // No display name anywhere: readable, never a path.
    expect(searchEntityLabel({ kind: 'model', key: 'acme-video-turbo_v2', label: 'acme/video-turbo_v2' })).toBe('Acme Video Turbo V2');
    // A name with a slash that a person wrote is theirs.
    expect(searchEntityLabel({ kind: 'model', key: 'flux-dev-schnell', label: 'Flux Dev / Schnell' })).toBe('Flux Dev / Schnell');
  });

  it('names a tool as its posts print it, whatever its key', () => {
    expect(searchEntityLabel({ kind: 'tool', key: 'kling-2.6-motion-control', label: 'kling-2.6/motion-control' })).toBe('kling-2.6/motion-control');
    expect(searchEntityLabel({ kind: 'tool', key: 'nano-banana-pro', label: 'A tool of that name' })).toBe('A tool of that name');
  });

  it('is the one place both full search and the typeahead choose an entity’s name', () => {
    const search = source('src/lib/public-search-service.ts');
    expect(search).toContain("import { searchEntityLabel } from '@/lib/search-entity-label';");
    expect(search).toContain('label: searchEntityLabel(row),');
    expect(search).not.toContain('getPostModelDisplayName');
    // The typeahead maps an entity with full search's own function.
    expect(source('src/lib/search-suggest-service.ts')).toContain("import { entityResult } from '@/lib/public-search-service';");
  });
});
