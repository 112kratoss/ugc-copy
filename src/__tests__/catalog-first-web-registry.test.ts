import { describe, expect, it } from 'vitest';

import {
  applyGenerationModelCatalogToRegistries,
  getActiveRegistryModels,
  type GenerationModelCatalog,
} from '@/lib/generation-model-client';

/**
 * Catalog-first exposure on web: a model published to the DB catalog but absent
 * from the static client registries must still be upserted into the picker
 * registries with renderable defaults. This is what lets a manifest-only model
 * reach web without a deploy (mobile is already catalog-driven); webEnabled in
 * the manifest stays the editorial hold-back switch.
 */

function syntheticCatalog(): GenerationModelCatalog {
  return {
    schemaVersion: 2,
    revision: 'test-rev',
    defaults: { image: 'nano-banana-2', video: 'kling-3.0-video', motion: 'kling-2.6' },
    models: [
      {
        id: 'future-image-model',
        kind: 'image',
        displayName: 'Future Image Model',
        description: 'A model that exists only in the catalog.',
        badge: 'New',
        recommended: false,
        sortOrder: 500,
        minClientSchemaVersion: 1,
        controls: [
          {
            key: 'aspectRatio',
            label: 'Aspect ratio',
            type: 'choice',
            presentation: 'chips',
            defaultValue: '1:1',
            options: [{ value: '1:1', label: '1:1' }, { value: '16:9', label: '16:9' }],
          },
          {
            key: 'resolution',
            label: 'Resolution',
            type: 'choice',
            presentation: 'chips',
            defaultValue: '1K',
            options: [{ value: '1K', label: '1K' }],
          },
        ],
        capabilities: {
          multiShot: false,
          sound: false,
          fixedLens: false,
          googleSearch: false,
          outputFormat: false,
        },
        inputs: {
          imageReferences: { max: 2, supportsNaming: false },
          videoReferences: null,
          audioReferences: null,
          preparedAudioReferences: null,
          characterReferences: null,
          startFrame: false,
          endFrame: false,
          combineFramesWithReferences: false,
        },
        inputModes: [],
        inputConstraints: [],
      } as unknown as GenerationModelCatalog['models'][number],
      {
        id: 'future-video-model',
        kind: 'video',
        displayName: 'Future Video Model',
        description: 'A catalog-only video model.',
        badge: null,
        recommended: false,
        sortOrder: 510,
        minClientSchemaVersion: 1,
        controls: [
          {
            key: 'resolution',
            label: 'Resolution',
            type: 'choice',
            presentation: 'chips',
            defaultValue: '720p',
            options: [{ value: '720p', label: '720p' }],
          },
          {
            key: 'duration',
            label: 'Duration',
            type: 'integer',
            presentation: 'stepper',
            defaultValue: 5,
            min: 3,
            max: 15,
            step: 1,
            unit: 'seconds',
          },
        ],
        capabilities: {
          multiShot: false,
          sound: true,
          fixedLens: false,
          googleSearch: false,
          outputFormat: false,
        },
        inputs: {
          imageReferences: { max: 1, supportsNaming: false },
          videoReferences: null,
          audioReferences: null,
          preparedAudioReferences: null,
          characterReferences: null,
          startFrame: true,
          endFrame: false,
          combineFramesWithReferences: false,
        },
        inputModes: [],
        inputConstraints: [],
      } as unknown as GenerationModelCatalog['models'][number],
    ],
  } as unknown as GenerationModelCatalog;
}

describe('catalog-first web exposure', () => {
  it('upserts catalog-only models into fresh registries with renderable defaults', () => {
    const registries = { image: {}, video: {}, motion: {} } as Parameters<
      typeof applyGenerationModelCatalogToRegistries
    >[1];
    applyGenerationModelCatalogToRegistries(syntheticCatalog(), registries);

    const image = (registries as { image: Record<string, Record<string, unknown>> }).image['future-image-model'];
    expect(image).toBeDefined();
    expect(image.displayName).toBe('Future Image Model');
    expect(image.aspectRatios).toEqual(['1:1', '16:9']);
    expect(image.resolutions).toEqual(['1K']);
    expect(image.outputFormats).toEqual(['jpg']);
    expect(image.badgeColor).toBeTruthy();
    expect(image.accentColor).toBeTruthy();
    expect(image.maxImages).toBe(2);
    expect(image.catalogManaged).toBe(true);

    const video = (registries as { video: Record<string, Record<string, unknown>> }).video['future-video-model'];
    expect(video).toBeDefined();
    expect(video.supportsSound).toBe(true);
    expect(video.resolutions).toEqual(['720p']);
    expect(video.singleShotDurationRange).toEqual({ min: 3, max: 15, default: 5 });
    expect(video.catalogInputs).toBeDefined();
  });

  it('keeps upserted models visible through getActiveRegistryModels', () => {
    const registries = { image: {}, video: {}, motion: {} } as Parameters<
      typeof applyGenerationModelCatalogToRegistries
    >[1];
    applyGenerationModelCatalogToRegistries(syntheticCatalog(), registries);
    const active = getActiveRegistryModels(
      (registries as { image: Record<string, Record<string, unknown>> }).image,
    );
    expect(active.map((model) => model.id)).toContain('future-image-model');
  });

  it('preserves existing static-entry styling when the catalog overlays it', () => {
    const registries = {
      image: {
        'future-image-model': { badgeColor: 'from-pink-500 to-rose-500', accentColor: 'amber' },
      },
      video: {},
      motion: {},
    } as unknown as Parameters<typeof applyGenerationModelCatalogToRegistries>[1];
    applyGenerationModelCatalogToRegistries(syntheticCatalog(), registries);
    const image = (registries as { image: Record<string, Record<string, unknown>> }).image['future-image-model'];
    expect(image.badgeColor).toBe('from-pink-500 to-rose-500');
    expect(image.accentColor).toBe('amber');
  });
});
