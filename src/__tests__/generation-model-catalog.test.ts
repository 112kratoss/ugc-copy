import { describe, expect, it } from 'vitest';

import {
  CatalogError,
  buildGenerationModelCatalog,
  quoteGenerationModel,
} from '@/lib/generation-model-catalog';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';

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

  it('publishes the new image models with their reference limits', () => {
    const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 1 });

    expect(catalog.models.find((model) => model.id === 'nano-banana-2-lite')).toMatchObject({
      kind: 'image',
      inputs: { imageReferences: { max: 10, supportsNaming: true } },
    });
    expect(catalog.models.find((model) => model.id === 'seedream-5-pro')).toMatchObject({
      inputs: { imageReferences: { max: 10, supportsNaming: true } },
    });
    expect(catalog.models.find((model) => model.id === 'flux-2-pro')).toMatchObject({
      inputs: { imageReferences: { max: 8, supportsNaming: true } },
    });
    expect(catalog.models.find((model) => model.id === 'z-image')).toMatchObject({
      inputs: { imageReferences: null },
    });
    expect(catalog.models.find((model) => model.id === 'ideogram-v3')).toMatchObject({
      inputs: { imageReferences: { max: 1, supportsNaming: true } },
    });
    expect(catalog.models.find((model) => model.id === 'gemini-omni-video')).toMatchObject({
      inputs: {
        imageReferences: { max: 7 },
        videoReferences: { max: 1 },
        audioReferences: null,
        preparedAudioReferences: { max: 3 },
        characterReferences: { max: 3 },
      },
    });
    expect(catalog.models.find((model) => model.id === 'wan-2.7')).toMatchObject({
      inputs: { combineFramesWithReferences: true },
    });
  });

  it('quotes Ideogram speed and enforces provider-specific reference rules', () => {
    expect(quoteGenerationModel({
      kind: 'image', modelId: 'ideogram-v3',
      settings: { aspectRatio: '1:1', resolution: '1K', qualityMode: 'balanced' },
      inputCounts: { images: 0, videos: 0, audios: 0 },
    }).costCredits).toBe(7);

    expect(() => quoteGenerationModel({
      kind: 'image', modelId: 'wan-2.7-image-pro',
      settings: { aspectRatio: 'auto', resolution: '4K' },
      inputCounts: { images: 1, videos: 0, audios: 0 },
    })).toThrow(CatalogError);

    expect(() => quoteGenerationModel({
      kind: 'video', modelId: 'gemini-omni-video',
      settings: { aspectRatio: '16:9', resolution: '720p', duration: 4, referenceMode: 'elements' },
      inputCounts: { images: 6, videos: 1, audios: 0 },
    })).toThrow(CatalogError);

    expect(() => quoteGenerationModel({
      kind: 'video', modelId: 'gemini-omni-video',
      settings: { aspectRatio: '16:9', resolution: '720p', duration: 4, referenceMode: 'elements' },
      inputCounts: { images: 2, videos: 1, audios: 0, preparedAudios: 1, characters: 4 },
    })).toThrowError(expect.objectContaining({
      fieldErrors: expect.objectContaining({ characters: 'Gemini Omni supports up to 3 prepared character references.' }),
    }));

    expect(() => quoteGenerationModel({
      kind: 'video', modelId: 'gemini-omni-video',
      settings: { aspectRatio: '16:9', resolution: '720p', duration: 4, referenceMode: 'elements' },
      inputCounts: { images: 3, videos: 1, audios: 0, preparedAudios: 1, characters: 3 },
    })).toThrowError(expect.objectContaining({
      fieldErrors: expect.objectContaining({ references: 'Gemini Omni supports seven reference slots; videos use two and characters use one.' }),
    }));
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
  it('keeps catalog-backed pricing equivalent to the verified code catalog', () => {
    const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 1 });
    const operations = new Map(buildCodeGenerationModelOperations().map((entry) => [entry.modelId, entry]));

    for (const model of catalog.models) {
      const settings = Object.fromEntries(model.controls.map((control) => [control.key, control.defaultValue]));
      const inputCounts = {
        images: model.id === 'hailuo-2.3' ? 1 : 0,
        videos: 0,
        audios: 0,
      };
      const input = { kind: model.kind, modelId: model.id, settings, inputCounts };

      const legacyQuote = quoteGenerationModel(input);
      const catalogBackedQuote = quoteGenerationModel(input, { catalog, operations });

      expect(catalogBackedQuote, model.id).toEqual(legacyQuote);
    }
  });

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

  it('quotes current Kie rates for corrected Kling and Seedance variants', () => {
    const cases = [
      {
        kind: 'motion' as const,
        modelId: 'kling-2.6',
        settings: { resolution: '720p', duration: 10, characterOrientation: 'video' },
        inputCounts: { images: 1, videos: 1, audios: 0 },
        expectedCost: 110,
      },
      {
        kind: 'motion' as const,
        modelId: 'kling-3.0',
        settings: { resolution: '1080p', duration: 10, characterOrientation: 'video' },
        inputCounts: { images: 1, videos: 1, audios: 0 },
        expectedCost: 270,
      },
      {
        kind: 'video' as const,
        modelId: 'kling-3.0-video',
        settings: { aspectRatio: '16:9', mode: 'std', duration: 5, sound: true },
        inputCounts: { images: 0, videos: 0, audios: 0 },
        expectedCost: 100,
      },
      {
        kind: 'video' as const,
        modelId: 'seedance-2-fast',
        settings: { aspectRatio: '16:9', resolution: '480p', duration: 12, sound: true },
        inputCounts: { images: 1, videos: 1, audios: 1 },
        expectedCost: 108,
      },
    ];

    for (const testCase of cases) {
      expect(quoteGenerationModel({
        kind: testCase.kind,
        modelId: testCase.modelId,
        settings: testCase.settings,
        inputCounts: testCase.inputCounts,
      }).costCredits).toBe(testCase.expectedCost);
    }
  });

  it('quotes the added Kie image models with server-authoritative pricing', () => {
    const cases = [
      { modelId: 'nano-banana-2-lite', resolution: '1K', images: 10, expectedCost: 4 },
      { modelId: 'seedream-5-pro', resolution: '1K', images: 2, expectedCost: 8 },
      { modelId: 'seedream-5-pro', resolution: '2K', images: 4, expectedCost: 16 },
      { modelId: 'flux-2-pro', resolution: '2K', images: 8, expectedCost: 7 },
      { modelId: 'z-image', resolution: '1K', images: 0, expectedCost: 1 },
    ];

    for (const testCase of cases) {
      expect(quoteGenerationModel({
        kind: 'image',
        modelId: testCase.modelId,
        settings: { resolution: testCase.resolution },
        inputCounts: { images: testCase.images, videos: 0, audios: 0 },
      }).costCredits).toBe(testCase.expectedCost);
    }
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

  it('rejects reusable references when the selected Veo mode cannot use them', () => {
    expect(() => quoteGenerationModel({
      kind: 'video',
      modelId: 'veo-3.1',
      settings: {
        aspectRatio: '16:9',
        duration: 8,
        mode: 'veo3',
        resolution: '720p',
        referenceMode: 'elements',
      },
      inputCounts: { images: 1, videos: 0, audios: 0 },
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_MODEL_SETTINGS',
      fieldErrors: expect.objectContaining({
        images: 'Reusable references require Veo Lite or Fast.',
      }),
    }));
  });

  it('enforces Wan total reference limits and Hailuo start-image requirements', () => {
    expect(() => quoteGenerationModel({
      kind: 'video',
      modelId: 'wan-2.7',
      settings: {
        aspectRatio: '16:9',
        duration: 5,
        resolution: '720p',
        referenceMode: 'elements',
      },
      inputCounts: { images: 3, videos: 2, audios: 1 },
    })).toThrowError(expect.objectContaining({
      fieldErrors: expect.objectContaining({
        references: 'Wan 2.7 supports up to 5 reusable references in total.',
      }),
    }));

    expect(() => quoteGenerationModel({
      kind: 'video',
      modelId: 'hailuo-2.3',
      settings: {
        aspectRatio: '16:9',
        duration: 6,
        mode: 'standard',
        resolution: '768P',
        referenceMode: 'frames',
      },
      inputCounts: { images: 0, videos: 0, audios: 0 },
    })).toThrowError(expect.objectContaining({
      fieldErrors: expect.objectContaining({
        images: 'Hailuo 2.3 requires a start image.',
      }),
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
