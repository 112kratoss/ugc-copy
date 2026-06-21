import { describe, expect, it } from 'vitest';

import {
  CatalogError,
  buildGenerationModelCatalog,
  quoteGenerationModel,
} from '@/lib/generation-model-catalog';

describe('generation model catalog', () => {
  it('returns a deterministic schema-v1 catalog without private provider fields', () => {
    const first = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 1 });
    const second = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 1 });

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(1);
    expect(first.revision).toMatch(/^[a-f0-9]{16}$/);
    expect(first.defaults).toEqual({
      image: 'nano-banana-2',
      video: 'kling-3.0-video',
      motion: 'kling-2.6',
    });
    expect(first.models.some((model) => model.id === 'grok-imagine-image')).toBe(true);

    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain('apiModelId');
    expect(serialized).not.toContain('enhancerModelId');
    expect(serialized).not.toContain('provider');
    expect(serialized).not.toContain('pricing');
  });

  it('describes settings as schema-driven controls', () => {
    const catalog = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 1 });
    const grok = catalog.models.find((model) => model.id === 'grok-imagine-image');

    expect(grok).toMatchObject({
      kind: 'image',
      badge: 'New',
      inputs: { imageReferences: { max: 1, supportsNaming: true } },
    });
    expect(grok?.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'aspectRatio', type: 'choice', defaultValue: '3:2' }),
      expect.objectContaining({ key: 'resolution', type: 'choice', defaultValue: '1K' }),
      expect.objectContaining({ key: 'qualityMode', type: 'choice', defaultValue: 'standard' }),
    ]));
  });

  it('filters models that require a newer client schema', () => {
    const catalog = buildGenerationModelCatalog({
      platform: 'mobile',
      schemaVersion: 0,
    });

    expect(catalog.models).toEqual([]);
    expect(catalog.defaults).toEqual({ image: null, video: null, motion: null });
  });
});

describe('generation model quotes', () => {
  it('quotes image settings with the authoritative server pricing', () => {
    const catalog = buildGenerationModelCatalog({ platform: 'mobile', schemaVersion: 1 });
    const quote = quoteGenerationModel({
      kind: 'image',
      modelId: 'grok-imagine-image',
      settings: {
        aspectRatio: '3:2',
        resolution: '1K',
        qualityMode: 'quality',
      },
      inputCounts: { images: 0, videos: 0, audios: 0 },
      catalogRevision: catalog.revision,
    });

    expect(quote).toEqual({
      modelId: 'grok-imagine-image',
      catalogRevision: catalog.revision,
      normalizedSettings: {
        aspectRatio: '3:2',
        resolution: '1K',
        qualityMode: 'quality',
        outputFormat: 'jpg',
        googleSearch: false,
      },
      costCredits: 5,
    });
  });

  it('rejects invalid settings with field details', () => {
    expect(() => quoteGenerationModel({
      kind: 'image',
      modelId: 'grok-imagine-image',
      settings: { aspectRatio: '21:9', resolution: '4K' },
      inputCounts: { images: 0, videos: 0, audios: 0 },
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_MODEL_SETTINGS',
      status: 422,
      fieldErrors: expect.objectContaining({ aspectRatio: expect.any(String) }),
    }));
  });

  it('rejects stale catalog revisions before returning a price', () => {
    expect(() => quoteGenerationModel({
      kind: 'motion',
      modelId: 'kling-2.6',
      settings: { resolution: '720p', duration: 10, characterOrientation: 'video' },
      inputCounts: { images: 1, videos: 1, audios: 0 },
      catalogRevision: 'stale-revision',
    })).toThrowError(expect.objectContaining({
      code: 'CATALOG_CHANGED',
      status: 409,
    } satisfies Partial<CatalogError>));
  });
});
