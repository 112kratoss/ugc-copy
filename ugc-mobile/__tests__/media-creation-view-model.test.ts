import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyModelDefaults,
  buildGenerationPayload,
  buildPromptEnhancementRequest,
  createDefaultCreationDraft,
  createMediaDraftFromUpload,
  getCreationReadiness,
  getCreationSectionOrder,
  getCreationSectionSummary,
  getVisibleGenerationCheckMessages,
  hydrateCreationDraftFromRemixSource,
  renameMediaDraft,
  replaceMediaDraftMedia,
  validateCreationDraft,
  VIDEO_MODELS,
  type MediaDraft,
} from '../lib/media-creation-view-model';
import type { RemixSourceBundle } from '../lib/types';

const repoRoot = process.cwd();

function imageReference(overrides: Partial<MediaDraft> = {}): MediaDraft {
  return createMediaDraftFromUpload(
    {
      signedUrl: overrides.url ?? 'https://cdn.example.com/ref.png',
      storagePath: overrides.storagePath ?? 'uploads/user/ref.png',
      mimeType: 'image/png',
      fileName: overrides.fileName ?? 'ref.png',
      kind: 'image',
    },
    {
      displayName: overrides.displayName ?? 'Hero Product',
      sourceGenerationId: overrides.sourceGenerationId,
    }
  );
}

function videoReference(overrides: Partial<MediaDraft> = {}): MediaDraft {
  return createMediaDraftFromUpload(
    {
      signedUrl: overrides.url ?? 'https://cdn.example.com/reference.mp4',
      storagePath: overrides.storagePath ?? 'uploads/user/reference.mp4',
      mimeType: 'video/mp4',
      fileName: overrides.fileName ?? 'reference.mp4',
      kind: 'video',
      durationSeconds: overrides.durationSeconds ?? 7.4,
    },
    {
      displayName: overrides.displayName ?? 'Reference Motion',
    }
  );
}

function audioReference(overrides: Partial<MediaDraft> = {}): MediaDraft {
  return createMediaDraftFromUpload(
    {
      signedUrl: overrides.url ?? 'https://cdn.example.com/voice.mp3',
      storagePath: overrides.storagePath ?? 'uploads/user/voice.mp3',
      mimeType: 'audio/mpeg',
      fileName: overrides.fileName ?? 'voice.mp3',
      kind: 'audio',
    },
    {
      displayName: overrides.displayName ?? 'Voice Reference',
    }
  );
}

type RemixSourceBundleOverrides = Omit<Partial<RemixSourceBundle>, 'generation' | 'inputs' | 'workflowSettings'> & {
  generation?: Partial<RemixSourceBundle['generation']>;
  inputs?: Partial<RemixSourceBundle['inputs']>;
  workflowSettings?: Record<string, unknown>;
};

function remixSourceBundle(overrides: RemixSourceBundleOverrides = {}): RemixSourceBundle {
  const base: RemixSourceBundle = {
    generation: {
      id: 'gen-source',
      title: 'Original source',
      prompt: 'Create a premium tabletop product scene.',
      category: 'image',
      model: 'nano-banana-2',
    },
    result: null,
    inputs: {},
    workflowSettings: {},
    restoreIssues: [],
  };

  return {
    ...base,
    ...overrides,
    generation: {
      ...base.generation,
      ...overrides.generation,
    },
    inputs: {
      ...base.inputs,
      ...overrides.inputs,
    },
    workflowSettings: {
      ...base.workflowSettings,
      ...overrides.workflowSettings,
    },
    restoreIssues: overrides.restoreIssues ?? base.restoreIssues,
  };
}

describe('media creation view model', () => {
  it('offers the current Seedance 2 resolution tiers in the mobile fallback catalog', () => {
    expect(VIDEO_MODELS['seedance-2'].resolutions).toEqual(['480p', '720p', '1080p', '4k']);
  });

  it('keeps authoritative generation pricing out of the mobile view model', () => {
    const source = readFileSync(join(repoRoot, 'lib/media-creation-view-model.ts'), 'utf8');

    expect(source).not.toMatch(/\bpricing\s*:/);
    expect(source).not.toMatch(/\bprovider\s*:/);
    expect(source).not.toContain('qualityPricing');
    expect(source).not.toContain('getCreditEstimate');
  });

  it('does not locally calculate credit costs without a server quote', () => {
    const draft = {
      ...createDefaultCreationDraft('image'),
      prompt: 'Create a cinematic product photo on a marble counter.',
    };

    const validation = validateCreationDraft(draft, { credits: 0 });

    expect(validation.cost).toBe(0);
    expect(validation.canGenerate).toBe(false);
    expect(validation.errors.some((error) => error.startsWith('Insufficient credits.'))).toBe(false);
  });

  it('renames media references and refreshes image handles', () => {
    expect(renameMediaDraft(imageReference(), 'Logo Sheet')).toMatchObject({
      displayName: 'Logo Sheet',
      handle: '@logo_sheet',
    });
    expect(renameMediaDraft(videoReference(), 'Dance Loop')).toMatchObject({
      displayName: 'Dance Loop',
      handle: undefined,
    });
    expect(renameMediaDraft(imageReference(), '')).toMatchObject({
      displayName: '',
      handle: undefined,
    });
  });

  it('replaces a reference media in place while keeping its identity', () => {
    const original = imageReference({ sourceGenerationId: 'gen-1' });

    const replaced = replaceMediaDraftMedia(original, {
      signedUrl: 'https://cdn.example.com/swapped.jpg',
      storagePath: 'uploads/user/swapped.jpg',
      mimeType: 'image/jpeg',
      fileName: 'swapped.jpg',
      kind: 'image',
      sizeBytes: 2048,
    });

    // Identity survives: id, name, and the @handle prompt mentions point at.
    expect(replaced.id).toBe(original.id);
    expect(replaced.displayName).toBe(original.displayName);
    expect(replaced.handle).toBe(original.handle);
    // The media itself is swapped, and the generation provenance is cleared —
    // the new file is a fresh upload, not a copy of a generation.
    expect(replaced).toMatchObject({
      url: 'https://cdn.example.com/swapped.jpg',
      storagePath: 'uploads/user/swapped.jpg',
      mimeType: 'image/jpeg',
      fileName: 'swapped.jpg',
      sizeBytes: 2048,
      sourceGenerationId: null,
    });
  });

  it('orders required creation work by tool shape', () => {
    expect(getCreationSectionOrder(createDefaultCreationDraft('image'))).toEqual([
      'prompt',
      'references',
      'essentials',
      'advanced',
      'generate',
    ]);
    expect(getCreationSectionOrder(createDefaultCreationDraft('video'))).toEqual([
      'prompt',
      'references',
      'essentials',
      'advanced',
      'generate',
    ]);
    expect(getCreationSectionOrder(createDefaultCreationDraft('motion'))).toEqual([
      'essentials',
      'references',
      'prompt',
      'advanced',
      'generate',
    ]);
  });

  it('keeps generation checks for details not already covered by readiness rows', () => {
    const motionDraft = createDefaultCreationDraft('motion');
    const validation = validateCreationDraft(motionDraft, { credits: 6 });

    expect(getVisibleGenerationCheckMessages(validation, null)).toEqual({
      message: null,
      errors: [],
      warnings: [],
    });

    const invalidVideoDraft = {
      ...createDefaultCreationDraft('video'),
      prompt: 'Animate the attached references.',
      references: [imageReference(), imageReference({ displayName: 'Second Product' })],
      startFrame: imageReference({ displayName: 'Start Frame' }),
      referenceMode: 'elements' as const,
    };
    expect(getVisibleGenerationCheckMessages(validateCreationDraft(invalidVideoDraft), null).errors).not.toContain(
      'Image references cannot be combined with start or end frames in the same run.'
    );
    expect(buildGenerationPayload(invalidVideoDraft)).toMatchObject({ startImageUrl: null, endImageUrl: null });
  });

  it('summarizes image creation readiness and progressive sections', () => {
    const draft = {
      ...createDefaultCreationDraft('image'),
      prompt: 'Create a cinematic product photo on a marble counter.',
      references: [imageReference()],
    };
    const validation = validateCreationDraft(draft, { credits: 999 });

    expect(getCreationSectionSummary(draft)).toEqual({
      essentials: 'Nano Banana 2.0 · 4:5 · 1K',
      references: '1 reference image',
      advanced: 'JPG · Search off',
    });
    expect(getCreationReadiness(draft, validation)).toEqual([
      expect.objectContaining({
        id: 'prompt',
        label: 'Prompt ready',
        state: 'ready',
      }),
      expect.objectContaining({
        id: 'media',
        label: 'References optional',
        body: '1 reference image attached.',
        state: 'ready',
      }),
      expect.objectContaining({
        id: 'settings',
        label: 'Settings ready',
        body: 'Nano Banana 2.0 · 4:5 · 1K',
        state: 'ready',
      }),
      expect.objectContaining({
        id: 'cost',
        label: 'Model settings unavailable',
        state: 'warning',
      }),
    ]);
  });

  it('summarizes video frames/elements and motion required media readiness', () => {
    const videoDraft = {
      ...createDefaultCreationDraft('video'),
      prompt: 'Slow push-in on @hero_product with warm creator lighting.',
      model: 'seedance-2-fast' as const,
      references: [imageReference()],
      referenceMode: 'elements' as const,
      duration: 12,
      resolution: '720p',
    };
    expect(getCreationSectionSummary(videoDraft)).toEqual({
      essentials: 'Seedance 2 Fast · 9:16 · 12s',
      references: 'Reusable refs · 1 image reference',
      advanced: '720p · sound off',
    });

    const motionDraft = createDefaultCreationDraft('motion');
    const validation = validateCreationDraft(motionDraft, { credits: 999 });
    expect(getCreationSectionSummary(motionDraft)).toEqual({
      essentials: 'Kling 3.0 · 720p · 10s',
      references: 'Character missing · motion missing',
      advanced: 'Video orientation',
    });
    expect(getCreationReadiness(motionDraft, validation)).toEqual([
      expect.objectContaining({
        id: 'prompt',
        label: 'Prompt optional',
        state: 'neutral',
      }),
      expect.objectContaining({
        id: 'media',
        label: 'Motion media needed',
        body: 'Add a character image and reference motion video.',
        state: 'warning',
      }),
      expect.objectContaining({
        id: 'settings',
        label: 'Settings ready',
        body: 'Kling 3.0 · 720p · 10s',
        state: 'ready',
      }),
      expect.objectContaining({
        id: 'cost',
        label: 'Model settings unavailable',
        state: 'warning',
      }),
    ]);
  });

  it('hydrates image remix source prompt, compatible settings, and element references', () => {
    const source = remixSourceBundle({
      workflowSettings: {
        model: 'nano-banana-2',
        aspectRatio: '9:16',
        resolution: '4K',
        qualityMode: 'quality',
        outputFormat: 'png',
        googleSearch: true,
      },
      inputs: {
        image: {
          elements: [
            {
              id: 'element-1',
              displayName: 'Hero Product',
              handle: '@hero_product',
              url: 'https://cdn.example.com/hero.png',
              storagePath: 'inputs/hero.png',
              sourceGenerationId: 'gen-source',
            },
            {
              id: 'element-2',
              displayName: 'Logo Sheet',
              handle: '@logo_sheet',
              url: 'https://cdn.example.com/logo.png',
              storagePath: 'inputs/logo.png',
              sourceGenerationId: 'gen-source',
            },
          ],
        },
      },
    });

    const { draft, warning } = hydrateCreationDraftFromRemixSource(createDefaultCreationDraft('image'), source);

    expect(warning).toBeNull();
    expect(draft).toMatchObject({
      prompt: 'Create a premium tabletop product scene.',
      sourceGenerationId: 'gen-source',
      model: 'nano-banana-2',
      aspectRatio: '9:16',
      resolution: '4K',
      qualityMode: 'quality',
      outputFormat: 'png',
      googleSearch: true,
    });
    expect(draft.references).toHaveLength(2);
    expect(draft.references[0]).toMatchObject({
      id: 'element-1',
      displayName: 'Hero Product',
      handle: '@hero_product',
      url: 'https://cdn.example.com/hero.png',
      storagePath: 'inputs/hero.png',
      sourceGenerationId: 'gen-source',
    });
  });

  it('hydrates video remix source start and end frames in frame mode', () => {
    const source = remixSourceBundle({
      generation: {
        category: 'video',
        model: 'seedance-2-fast',
      },
      workflowSettings: {
        model: 'seedance-2-fast',
        aspectRatio: '16:9',
        duration: 12,
        resolution: '720p',
        sound: true,
      },
      inputs: {
        video: {
          referenceMode: 'frames',
          startFrame: {
            kind: 'image',
            label: 'Start Frame',
            url: 'https://cdn.example.com/start.jpg',
            storagePath: 'inputs/start.jpg',
            sourceGenerationId: 'gen-source',
          },
          endFrame: {
            kind: 'image',
            label: 'End Frame',
            url: 'https://cdn.example.com/end.jpg',
            storagePath: 'inputs/end.jpg',
            sourceGenerationId: 'gen-source',
          },
          elements: [],
          referenceVideos: [],
          referenceAudios: [],
        },
      },
    });

    const { draft, warning } = hydrateCreationDraftFromRemixSource(createDefaultCreationDraft('video'), source);

    expect(warning).toBeNull();
    expect(draft).toMatchObject({
      model: 'seedance-2-fast',
      prompt: 'Create a premium tabletop product scene.',
      referenceMode: 'frames',
      aspectRatio: '16:9',
      duration: 12,
      resolution: '720p',
      sound: true,
      sourceGenerationId: 'gen-source',
    });
    expect(draft.startFrame).toMatchObject({ displayName: 'Start Frame', url: 'https://cdn.example.com/start.jpg' });
    expect(draft.endFrame).toMatchObject({ displayName: 'End Frame', url: 'https://cdn.example.com/end.jpg' });
    expect(draft.references).toEqual([]);
  });

  it('hydrates supported video image, video, and audio references', () => {
    const source = remixSourceBundle({
      generation: {
        category: 'video',
        model: 'seedance-2',
      },
      workflowSettings: {
        model: 'seedance-2',
        referenceMode: 'elements',
        duration: 10,
        resolution: '720p',
      },
      inputs: {
        video: {
          referenceMode: 'elements',
          startFrame: null,
          endFrame: null,
          elements: [
            {
              id: 'element-1',
              displayName: 'Hero Product',
              handle: '@hero_product',
              url: 'https://cdn.example.com/hero.png',
              storagePath: 'inputs/hero.png',
              sourceGenerationId: 'gen-source',
            },
          ],
          referenceVideos: [
            {
              kind: 'video',
              label: 'Motion Reference',
              url: 'https://cdn.example.com/motion.mp4',
              storagePath: 'inputs/motion.mp4',
              sourceGenerationId: 'gen-source',
            },
          ],
          referenceAudios: [
            {
              kind: 'audio',
              label: 'Voice Reference',
              url: 'https://cdn.example.com/voice.mp3',
              storagePath: 'inputs/voice.mp3',
              sourceGenerationId: 'gen-source',
            },
          ],
        },
      },
    });

    const { draft, warning } = hydrateCreationDraftFromRemixSource(createDefaultCreationDraft('video'), source);

    expect(warning).toBeNull();
    expect(draft.referenceMode).toBe('elements');
    expect(draft.references).toHaveLength(1);
    expect(draft.referenceVideos).toHaveLength(1);
    expect(draft.referenceAudios).toHaveLength(1);
    expect(draft.referenceVideos[0]).toMatchObject({ displayName: 'Motion Reference', kind: 'video' });
    expect(draft.referenceAudios[0]).toMatchObject({ displayName: 'Voice Reference', kind: 'audio' });
  });

  it('hydrates motion remix source character image and reference video', () => {
    const source = remixSourceBundle({
      generation: {
        category: 'video',
        model: 'kling-2.6',
      },
      workflowSettings: {
        model: 'kling-2.6',
        mode: '1080p',
        characterOrientation: 'image',
        duration: 18,
      },
      inputs: {
        motion: {
          characterImage: {
            kind: 'image',
            label: 'Character Image',
            url: 'https://cdn.example.com/character.png',
            storagePath: 'inputs/character.png',
            sourceGenerationId: 'gen-source',
          },
          referenceVideo: {
            kind: 'video',
            label: 'Reference Motion',
            url: 'https://cdn.example.com/reference.mp4',
            storagePath: 'inputs/reference.mp4',
            sourceGenerationId: 'gen-source',
          },
        },
      },
    });

    const { draft, warning } = hydrateCreationDraftFromRemixSource(createDefaultCreationDraft('motion'), source);

    expect(warning).toBeNull();
    expect(draft).toMatchObject({
      model: 'kling-2.6',
      prompt: 'Create a premium tabletop product scene.',
      mode: '1080p',
      characterOrientation: 'image',
      duration: 18,
      sourceGenerationId: 'gen-source',
    });
    expect(draft.characterImage).toMatchObject({ displayName: 'Character Image', kind: 'image' });
    expect(draft.referenceVideo).toMatchObject({ displayName: 'Reference Motion', kind: 'video' });
  });

  it('skips missing remix media URLs and surfaces a restore warning', () => {
    const source = remixSourceBundle({
      inputs: {
        image: {
          elements: [
            {
              id: 'element-1',
              displayName: 'Missing Product',
              handle: '@missing_product',
              url: null,
              storagePath: 'inputs/missing.png',
              sourceGenerationId: 'gen-source',
            },
          ],
        },
      },
      restoreIssues: ['Image input media is no longer available.'],
    });

    const { draft, warning } = hydrateCreationDraftFromRemixSource(createDefaultCreationDraft('image'), source);

    expect(draft.references).toEqual([]);
    expect(warning).toBe('Some source media could not be restored automatically, so you may need to re-add a few references.');
  });

  it('validates image prompts, unknown handles, max references, costs, and payload fields', () => {
    const draft = createDefaultCreationDraft('image');
    expect(validateCreationDraft(draft, { credits: 999 }).errors).toContain('Prompt is required.');

    const references = Array.from({ length: 2 }, (_value, index) =>
      imageReference({ url: `https://cdn.example.com/ref-${index}.png`, displayName: `Product ${index + 1}` })
    );
    const ready = {
      ...draft,
      prompt: 'Place @product_1 on a marble counter with soft retail lighting.',
      model: 'gpt-image-2' as const,
      aspectRatio: '9:16',
      resolution: '4K' as const,
      outputFormat: 'png' as const,
      googleSearch: true,
      references,
    };

    const validation = validateCreationDraft(ready, { credits: 999 });
    expect(validation.errors).toEqual([]);
    expect(validation.cost).toBe(0);
    expect(validation.canGenerate).toBe(false);

    const unknownValidation = validateCreationDraft({ ...ready, prompt: 'Use @missing beside @product_1.' });
    expect(unknownValidation.errors).toContain('Unknown element mention: @missing');

    const tooMany = {
      ...ready,
      model: 'grok-imagine-image' as const,
      references: [imageReference(), imageReference({ displayName: 'Second Product' })],
    };
    expect(validateCreationDraft(tooMany).errors).toContain('Grok Imagine supports up to 1 total reference image.');

    const payload = buildGenerationPayload(ready);
    expect(payload).toMatchObject({
      model: 'gpt-image-2',
      prompt: ready.prompt,
      aspectRatio: '9:16',
      resolution: '4K',
      outputFormat: 'jpg',
      googleSearch: false,
      imageUrls: ['https://cdn.example.com/ref-0.png', 'https://cdn.example.com/ref-1.png'],
      elements: [
        {
          displayName: 'Product 1',
          handle: '@product_1',
          storagePath: 'uploads/user/ref.png',
        },
        {
          displayName: 'Product 2',
          handle: '@product_2',
          storagePath: 'uploads/user/ref.png',
        },
      ],
    });
  });

  it('applies the added image model capabilities to mobile drafts', () => {
    const base = createDefaultCreationDraft('image');
    const zImageDraft = applyModelDefaults({
      ...base,
      model: 'z-image',
      prompt: 'A candid creator portrait in morning light.',
      aspectRatio: '4:5',
      resolution: '4K',
      references: [imageReference()],
    });

    expect(zImageDraft).toMatchObject({
      tool: 'image',
      model: 'z-image',
      aspectRatio: '1:1',
      resolution: '1K',
      references: [],
    });
    const zImageValidation = validateCreationDraft(zImageDraft, { credits: 999 });
    expect(
      getCreationReadiness(zImageDraft, zImageValidation).find((item) => item.id === 'media'),
    ).toMatchObject({
      label: 'Prompt-only model',
    });

    const seedreamPayload = buildGenerationPayload({
      ...base,
      model: 'seedream-5-pro',
      prompt: 'Use @hero in a premium product campaign.',
      aspectRatio: '9:16',
      resolution: '2K',
      outputFormat: 'png',
      references: [imageReference()],
    });

    expect(seedreamPayload).toMatchObject({
      model: 'seedream-5-pro',
      aspectRatio: '9:16',
      resolution: '2K',
      outputFormat: 'png',
      imageUrls: ['https://cdn.example.com/ref.png'],
    });
  });

  it('builds video payloads with multi-shot, element, frame, Seedance, and Grok validation rules', () => {
    const draft = createDefaultCreationDraft('video');
    expect(validateCreationDraft(draft).errors).toContain('Prompt is required.');

    const multiShot = {
      ...draft,
      prompt: '',
      isMultiShot: true,
      multiPrompts: [
        { id: 'shot-1', prompt: 'Close-up of the product opening on a table.', duration: 4 },
        { id: 'shot-2', prompt: '', duration: 5 },
      ],
    };
    expect(validateCreationDraft(multiShot).errors).toContain('All multi-shot entries need a text prompt.');

    const klingElements = {
      ...draft,
      prompt: 'Keep @hero_product centered while the camera pushes in.',
      model: 'kling-3.0-video' as const,
      references: [imageReference()],
      referenceMode: 'elements' as const,
    };
    expect(validateCreationDraft(klingElements).errors).toContain('Reusable image references are not available for Kling yet.');

    const frameConflict = {
      ...draft,
      prompt: 'Match @hero_product and move from the start frame to the end frame.',
      model: 'seedance-2' as const,
      references: [imageReference()],
      startFrame: imageReference({ displayName: 'Start Frame' }),
      referenceMode: 'elements' as const,
    };
    expect(validateCreationDraft(frameConflict).errors).not.toContain('Image references cannot be combined with start or end frames in the same run.');
    expect(buildGenerationPayload(frameConflict)).toMatchObject({ startImageUrl: null, endImageUrl: null });

    const seedanceVideoOverflow = {
      ...draft,
      prompt: 'Follow the attached motion reference exactly.',
      model: 'seedance-2' as const,
      referenceVideos: [
        videoReference({ durationSeconds: 7 }),
        videoReference({ durationSeconds: 6 }),
        videoReference({ durationSeconds: 4 }),
      ],
      referenceMode: 'elements' as const,
    };
    expect(validateCreationDraft(seedanceVideoOverflow).errors).toContain('Seedance 2 reference videos must be 15 seconds or less combined.');

    const grokTooManyImages = {
      ...draft,
      prompt: 'Animate the attached images.',
      model: 'grok-imagine-video' as const,
      references: [imageReference(), imageReference({ displayName: 'Second Product' })],
      referenceMode: 'elements' as const,
    };
    expect(validateCreationDraft(grokTooManyImages).errors).toContain('Grok Imagine Video supports up to 1 image reference per run.');

    const ready = {
      ...draft,
      prompt: 'Use @hero_product as the product reference, slow push-in camera, energetic creator movement.',
      model: 'seedance-2-fast' as const,
      aspectRatio: '9:16',
      duration: 12,
      resolution: '720p',
      sound: true,
      references: [imageReference()],
      referenceVideos: [videoReference({ durationSeconds: 4 })],
      referenceAudios: [audioReference()],
      referenceMode: 'elements' as const,
    };

    expect(validateCreationDraft(ready, { credits: 999 }).errors).toEqual([]);
    expect(validateCreationDraft(ready, { credits: 999 })).toMatchObject({ cost: 0, canGenerate: false });
    expect(buildGenerationPayload(ready)).toMatchObject({
      model: 'seedance-2-fast',
      prompt: ready.prompt,
      isMultiShot: false,
      aspectRatio: '9:16',
      duration: 12,
      resolution: '720p',
      sound: true,
      referenceMode: 'elements',
      imageUrls: ['https://cdn.example.com/ref.png'],
      elementImageUrls: ['https://cdn.example.com/ref.png'],
      referenceVideoUrls: ['https://cdn.example.com/reference.mp4'],
      referenceAudioUrls: ['https://cdn.example.com/voice.mp3'],
    });
  });

  it('validates motion required media, derives duration from the reference video, and builds the backend payload', () => {
    const draft = createDefaultCreationDraft('motion');
    expect(validateCreationDraft(draft).errors).toEqual([
      'Character image is required.',
      'Reference video is required.',
    ]);

    const tooLong = {
      ...draft,
      characterImage: imageReference(),
      referenceVideo: videoReference({ durationSeconds: 31 }),
    };
    expect(validateCreationDraft(tooLong).errors).toContain('Reference video must be between 1 and 30 seconds.');

    const ready = {
      ...draft,
      prompt: '',
      model: 'kling-3.0' as const,
      characterImage: imageReference(),
      referenceVideo: videoReference({ durationSeconds: 9.2 }),
      mode: '1080p' as const,
      characterOrientation: 'image' as const,
    };

    expect(validateCreationDraft(ready, { credits: 999 }).errors).toEqual([]);
    expect(validateCreationDraft(ready, { credits: 999 })).toMatchObject({ cost: 0, canGenerate: false });
    expect(buildGenerationPayload(ready)).toMatchObject({
      model: 'kling-3.0',
      prompt: '',
      characterImageUrl: 'https://cdn.example.com/ref.png',
      referenceVideoUrl: 'https://cdn.example.com/reference.mp4',
      characterOrientation: 'image',
      duration: 10,
      mode: '1080p',
      characterImage: { url: 'https://cdn.example.com/ref.png', storagePath: 'uploads/user/ref.png' },
      referenceVideo: { url: 'https://cdn.example.com/reference.mp4', storagePath: 'uploads/user/reference.mp4' },
    });
  });

  it('builds prompt enhancement requests with media context and credit validation', () => {
    const draft = {
      ...createDefaultCreationDraft('video'),
      prompt: 'A creator demonstrates @hero_product in a medium shot with upbeat voiceover.',
      model: 'seedance-2' as const,
      sound: true,
      references: [imageReference()],
      referenceVideos: [videoReference({ durationSeconds: 5 })],
      referenceMode: 'elements' as const,
      duration: 10,
    };

    expect(validateCreationDraft(draft, { credits: 10 }).errors.some((error) => error.startsWith('Insufficient credits.'))).toBe(false);
    expect(validateCreationDraft(draft, { credits: 10 })).toMatchObject({ cost: 0, canGenerate: false });
    expect(buildPromptEnhancementRequest(draft)).toMatchObject({
      medium: 'video',
      selectedModel: 'seedance-2',
      prompt: draft.prompt,
      context: {
        duration: 10,
        sound: true,
        hasReferenceVideo: true,
        referenceImageCount: 1,
        elementReferences: [{ handle: '@hero_product', displayName: 'Hero Product' }],
      },
    });
  });

  it('sends uploaded frame urls and the light-touch level to the enhancer', () => {
    const draft = {
      ...createDefaultCreationDraft('video'),
      prompt: 'She lifts the serum toward the camera.',
      model: 'veo-3.1' as const,
      referenceMode: 'frames' as const,
      startFrame: imageReference({ url: 'https://cdn.example.com/start.png', storagePath: 'uploads/user/start.png', displayName: 'Start', fileName: 'start.png' }),
      endFrame: imageReference({ url: 'https://cdn.example.com/end.png', storagePath: 'uploads/user/end.png', displayName: 'End', fileName: 'end.png' }),
    };

    const request = buildPromptEnhancementRequest(draft, { level: 'faithful' });
    expect(request.context).toMatchObject({
      hasStartImage: true,
      hasEndImage: true,
      frameImageUrls: ['https://cdn.example.com/start.png', 'https://cdn.example.com/end.png'],
      enhancementLevel: 'faithful',
    });

    // Default level stays implicit, and element mode never leaks frame urls.
    const defaultRequest = buildPromptEnhancementRequest(draft);
    expect(defaultRequest.context?.enhancementLevel).toBeUndefined();
    const elementsDraft = { ...draft, referenceMode: 'elements' as const };
    expect(buildPromptEnhancementRequest(elementsDraft).context?.frameImageUrls).toBeUndefined();
  });
});
