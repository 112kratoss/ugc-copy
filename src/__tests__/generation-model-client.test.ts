import { describe, expect, it, vi } from 'vitest';

import contractFixture from '../../contracts/generation-model-catalog-v1.json';
import {
  applyGenerationModelCatalogToRegistries,
  getActiveRegistryModels,
  loadWebGenerationModelCatalog,
  parseClientGenerationModelCatalog,
  requestWebGenerationQuote,
  resolveCatalogModelId,
  resolveWebGenerationQuoteUi,
} from '@/lib/generation-model-client';

describe('web generation model catalog client', () => {
  it('parses the shared schema-v1 fixture', () => {
    const catalog = parseClientGenerationModelCatalog(contractFixture);
    expect(catalog.models[0]).toMatchObject({ id: 'fixture-image', kind: 'image' });
  });

  it('rejects malformed web catalog controls and defaults', () => {
    expect(() => parseClientGenerationModelCatalog({
      ...contractFixture,
      defaults: { ...contractFixture.defaults, image: 'missing-image' },
    })).toThrow('Invalid generation model catalog');

    expect(() => parseClientGenerationModelCatalog({
      ...contractFixture,
      models: [{
        ...contractFixture.models[0],
        controls: [{
          key: 'aspectRatio',
          label: 'Aspect ratio',
          type: 'choice',
          presentation: 'chips',
          defaultValue: '1:1',
          options: [],
        }],
      }],
    })).toThrow('Invalid generation model catalog');
  });

  it('adapts a remote-only model into the legacy web registry shape', () => {
    const catalog = parseClientGenerationModelCatalog(contractFixture);
    const registries = { image: { 'retired-image': { id: 'retired-image' } }, video: {}, motion: {} };

    applyGenerationModelCatalogToRegistries(catalog, registries);

    expect(registries.image).toHaveProperty('fixture-image');
    expect((registries.image as Record<string, Record<string, unknown>>)['fixture-image']).toMatchObject({
      id: 'fixture-image',
      displayName: 'Fixture Image',
      aspectRatios: ['1:1', '9:16'],
      maxImages: 2,
      supportsGoogleSearch: true,
      catalogManaged: true,
      catalogActive: true,
    });
    expect(registries.image['retired-image']).toMatchObject({ catalogActive: false });
    expect(getActiveRegistryModels(registries.image).map((model) => model.id)).toEqual(['fixture-image']);
    expect(resolveCatalogModelId(catalog, 'image', 'retired-image')).toBe('fixture-image');
  });

  it('prefers the server default when resolving a fresh active selection', () => {
    const catalog = parseClientGenerationModelCatalog({
      ...contractFixture,
      models: [
        ...contractFixture.models,
        { ...contractFixture.models[0], id: 'bundled-active-image', displayName: 'Bundled Active Image' },
      ],
    });

    expect(resolveCatalogModelId(catalog, 'image', 'bundled-active-image', { preferDefault: true })).toBe('fixture-image');
  });

  it('uses the last valid local catalog when the network request fails', async () => {
    const storage = {
      getItem: vi.fn(() => JSON.stringify(contractFixture)),
      setItem: vi.fn(),
    };
    const fetcher = vi.fn(async () => {
      throw new Error('offline');
    });

    await expect(loadWebGenerationModelCatalog({ fetcher: fetcher as unknown as typeof fetch, storage })).resolves.toMatchObject({
      revision: '0123456789abcdef',
    });
  });

  it('bypasses the browser cache when refreshing after a catalog conflict', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(contractFixture), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await loadWebGenerationModelCatalog({
      fetcher: fetcher as unknown as typeof fetch,
      storage: undefined,
      forceRefresh: true,
    });

    expect(fetcher).toHaveBeenCalledWith(
      '/api/generation-models?platform=web&schemaVersion=1&refresh=1',
      { cache: 'no-store', headers: expect.any(Headers) }
    );
  });

  it('requests an authoritative quote with the current catalog revision', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      modelId: 'fixture-image',
      catalogRevision: '0123456789abcdef',
      normalizedSettings: { aspectRatio: '1:1' },
      costCredits: 7,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(requestWebGenerationQuote({
      kind: 'image',
      modelId: 'fixture-image',
      settings: { aspectRatio: '1:1' },
      inputCounts: { images: 0, videos: 0, audios: 0 },
      catalogRevision: '0123456789abcdef',
    }, 'token-1', undefined, fetcher as unknown as typeof fetch)).resolves.toMatchObject({ costCredits: 7 });

    expect(fetcher).toHaveBeenCalledWith('/api/generation-models/quote', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
    }));
  });

  it('surfaces the first quote field error as an actionable message', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: 'The quote request could not be processed.',
      code: 'INVALID_MODEL_SETTINGS',
      fieldErrors: { images: 'Hailuo 2.3 requires a start image.' },
    }), { status: 422, headers: { 'Content-Type': 'application/json' } }));

    await expect(requestWebGenerationQuote({
      kind: 'video',
      modelId: 'hailuo-2.3',
      settings: { referenceMode: 'frames' },
      inputCounts: { images: 0, videos: 0, audios: 0 },
    }, null, undefined, fetcher as unknown as typeof fetch)).rejects.toMatchObject({
      message: 'Hailuo 2.3 requires a start image.',
      code: 'INVALID_MODEL_SETTINGS',
      fieldErrors: { images: 'Hailuo 2.3 requires a start image.' },
    });
  });

  it('does not expose a fallback cost when the catalog is unavailable', () => {
    expect(resolveWebGenerationQuoteUi({
      hasCatalog: false,
      quoteStatus: 'idle',
      quotedCost: null,
      quoteErrorMessage: null,
    })).toMatchObject({
      costCredits: null,
      costLabel: 'Unavailable',
      blocksGenerate: true,
      message: 'Model settings are unavailable. Retry before generating.',
    });
  });

  it('requires an authoritative server quote before showing a cost', () => {
    expect(resolveWebGenerationQuoteUi({
      hasCatalog: true,
      quoteStatus: 'pending',
      quotedCost: null,
      quoteErrorMessage: null,
    })).toMatchObject({
      costCredits: null,
      costLabel: 'Calculating...',
      blocksGenerate: true,
      message: 'Wait for the current generation cost before continuing.',
    });

    expect(resolveWebGenerationQuoteUi({
      hasCatalog: true,
      quoteStatus: 'ready',
      quotedCost: 42,
      quoteErrorMessage: null,
    })).toMatchObject({
      costCredits: 42,
      costLabel: '42 credits',
      blocksGenerate: false,
      message: null,
    });

    expect(resolveWebGenerationQuoteUi({
      hasCatalog: true,
      quoteStatus: 'ready',
      quotedCost: 1,
      quoteErrorMessage: null,
    })).toMatchObject({
      costCredits: 1,
      costLabel: '1 credit',
      blocksGenerate: false,
      message: null,
    });
  });
});
