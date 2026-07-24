import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../lib/api-client';
import {
  GENERATION_MODEL_CATALOG_CACHE_KEY,
  GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  getActiveCatalogInputSlots,
  getCatalogModels,
  loadCachedGenerationModelCatalogEnvelope,
  parseGenerationModelCatalog,
  saveCachedGenerationModelCatalog,
} from '../lib/generation-model-catalog';
import { catalogV2, remoteVideoModel } from './generation-model-catalog-v2-fixtures';

describe('generation model catalog v2', () => {
  it('parses conditional slots and filters platform-unavailable models', () => {
    const hiddenModel = remoteVideoModel('web-only', {
      availability: { web: true, mobile: false },
    });
    const parsed = parseGenerationModelCatalog(
      catalogV2([...catalogV2().models, hiddenModel]),
      GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
    );
    const model = parsed.models.find((candidate) => candidate.id === 'remote-video-v2');
    if (!model) throw new Error('Expected the remote model.');

    expect(getActiveCatalogInputSlots(model, {
      referenceMode: 'elements',
      resolution: '1080p',
      duration: 7,
    }).map((slot) => slot.key)).toEqual(['imageReferences', 'videoReferences']);
    expect(getActiveCatalogInputSlots(model, {
      referenceMode: 'frames',
      resolution: '1080p',
      duration: 7,
    }).map((slot) => slot.key)).toEqual(['startFrame']);
    expect(getCatalogModels(parsed, 'video').map((candidate) => candidate.id)).not.toContain('web-only');
  });

  it('rejects unknown controls and malformed slot constraints', () => {
    const fixture = catalogV2();
    expect(() => parseGenerationModelCatalog({
      ...fixture,
      models: [{
        ...fixture.models[0],
        controls: [{ key: 'mystery', label: 'Mystery', type: 'mystery' }],
      }],
    }, 2)).toThrow('Invalid model catalog');

    expect(() => parseGenerationModelCatalog({
      ...fixture,
      models: [{
        ...fixture.models[0],
        inputConstraints: [{
          type: 'combined-duration',
          slotKeys: ['missing-slot'],
          max: 30,
          message: 'Invalid.',
        }],
      }],
    }, 2)).toThrow('Invalid model catalog');

    expect(() => parseGenerationModelCatalog({
      ...fixture,
      models: [{
        ...fixture.models[0],
        inputModes: fixture.models[0].inputModes?.map((mode) => ({
          ...mode,
          default: false,
        })),
      }],
    }, 2)).toThrow('Invalid model catalog');
  });

  it('allows one logical slot in different modes but rejects duplicates inside a mode', () => {
    const fixture = catalogV2();
    const model = fixture.models[0];
    const modelInputModes = model.inputModes;
    const sharedSlot = modelInputModes?.[0]?.slots[0];
    if (!sharedSlot || !modelInputModes) throw new Error('Expected v2 input modes.');
    const inputModes = modelInputModes.map((mode, index) => (
      index === 1
        ? { ...mode, slots: [...mode.slots, { ...sharedSlot }] }
        : mode
    ));

    expect(() => parseGenerationModelCatalog({
      ...fixture,
      models: [{ ...model, inputModes }],
    }, 2)).not.toThrow();

    expect(() => parseGenerationModelCatalog({
      ...fixture,
      models: [{
        ...model,
        inputModes: modelInputModes.map((mode, index) => (
          index === 0
            ? { ...mode, slots: [...mode.slots, { ...sharedSlot }] }
            : mode
        )),
      }],
    }, 2)).toThrow('Invalid model catalog');
  });

  it('keeps schema-v2 cache and ETag metadata in a separate namespace', async () => {
    const storage = {
      getItem: vi.fn().mockResolvedValue(null),
      setItem: vi.fn().mockResolvedValue(undefined),
    };
    const catalog = catalogV2();
    await saveCachedGenerationModelCatalog(catalog, storage, {
      etag: '"v2-etag"',
      fetchedAt: 42,
    });
    expect(storage.setItem).toHaveBeenCalledWith(
      GENERATION_MODEL_CATALOG_CACHE_KEY,
      JSON.stringify({ catalog, etag: '"v2-etag"', fetchedAt: 42 }),
    );

    storage.getItem.mockResolvedValue(JSON.stringify({
      catalog,
      etag: '"v2-etag"',
      fetchedAt: 42,
    }));
    await expect(loadCachedGenerationModelCatalogEnvelope(storage, 2)).resolves.toMatchObject({
      catalog: { schemaVersion: 2, revision: 'catalog-v2-revision' },
      etag: '"v2-etag"',
      fetchedAt: 42,
    });
  });

  it('requests schema v2 and reuses the cached ETag', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalogV2()), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        etag: '"catalog-etag"',
      },
    }));
    const api = createApiClient({
      baseUrl: 'https://api.example.com',
      getAccessToken: async () => null,
      clientInfo: {
        appVersion: '2.0.0',
        apiVersion: 2,
        catalogSchemaVersion: 2,
      },
      fetcher,
    });

    await expect(api.fetchGenerationModels({ etag: '"old-etag"' })).resolves.toMatchObject({
      catalog: { schemaVersion: 2 },
      etag: '"catalog-etag"',
      notModified: false,
    });
    expect(api.startGeneration).toBeTypeOf('function');
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('schemaVersion=2');
    expect(new Headers(init.headers).get('If-None-Match')).toBe('"old-etag"');
  });
});
