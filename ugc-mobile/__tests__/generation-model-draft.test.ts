import { describe, expect, it } from 'vitest';

import {
  applyCatalogModelDefaults,
  buildCatalogGenerationPayload,
  buildCatalogQuoteRequest,
  getCatalogCreationSectionSummary,
  validateCatalogCreationDraft,
} from '../lib/generation-model-draft';
import {
  createDefaultCreationDraft,
  createMediaDraftFromUpload,
  type VideoCreationDraft,
} from '../lib/media-creation-view-model';
import { createTestGenerationModelCatalog, remoteImageModel } from './fixtures/generation-model-catalog';

describe('catalog-backed mobile creation drafts', () => {
  it('applies remote model defaults and reference limits without bundled model data', () => {
    const draft = createDefaultCreationDraft('image');
    const normalized = applyCatalogModelDefaults({
      ...draft,
      model: remoteImageModel.id as typeof draft.model,
      references: Array.from({ length: 5 }, (_, index) => ({
        id: `ref-${index}`,
        url: `https://example.com/${index}.jpg`,
        kind: 'image' as const,
        fileName: `${index}.jpg`,
        displayName: `Reference ${index}`,
        handle: `@reference_${index}`,
      })),
    }, remoteImageModel);

    expect(normalized).toMatchObject({ model: 'remote-image-v1', aspectRatio: '2:3', resolution: '2K' });
    expect(normalized.tool === 'image' && normalized.references).toHaveLength(3);
  });

  it('builds summaries and quote requests from catalog-backed settings', () => {
    const draft = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('image'),
      model: remoteImageModel.id as 'nano-banana-2',
      prompt: 'A remote model test',
    }, remoteImageModel);
    if (draft.tool !== 'image') throw new Error('Expected an image draft.');

    expect(getCatalogCreationSectionSummary(draft, remoteImageModel).essentials).toBe('Remote Image V1 · 2:3 · 2K');
    expect(buildCatalogQuoteRequest(draft, remoteImageModel, 'revision-1')).toMatchObject({
      kind: 'image',
      modelId: 'remote-image-v1',
      settings: { aspectRatio: '2:3', resolution: '2K' },
      inputCounts: { images: 0, videos: 0, audios: 0 },
      catalogRevision: 'revision-1',
    });
    expect(buildCatalogGenerationPayload(draft, remoteImageModel, 'revision-1')).toMatchObject({
      model: 'remote-image-v1',
      prompt: 'A remote model test',
      aspectRatio: '2:3',
      resolution: '2K',
      outputFormat: 'jpg',
      googleSearch: false,
      catalogRevision: 'revision-1',
    });
  });

  it('validates remote controls and available credits using the server quote', () => {
    const draft = {
      ...createDefaultCreationDraft('image'),
      model: remoteImageModel.id as 'nano-banana-2',
      prompt: 'A remote model test',
      aspectRatio: '2:3',
      resolution: '2K' as '1K',
    };

    expect(validateCatalogCreationDraft(draft, remoteImageModel, { credits: 10, quotedCost: 6 })).toMatchObject({
      errors: [],
      cost: 6,
      canGenerate: true,
    });
    expect(validateCatalogCreationDraft(draft, remoteImageModel, { credits: 5, quotedCost: 6 }).errors).toContain(
      'Insufficient credits. This generation costs 6 credits.'
    );
  });

  it('does not mark a catalog draft generatable until an authoritative server quote is available', () => {
    const draft = {
      ...createDefaultCreationDraft('image'),
      model: remoteImageModel.id as 'nano-banana-2',
      prompt: 'A remote model test',
      aspectRatio: '2:3',
      resolution: '2K' as '1K',
    };

    expect(validateCatalogCreationDraft(draft, remoteImageModel, { credits: 10 })).toMatchObject({
      errors: [],
      cost: 0,
      canGenerate: false,
    });
  });

  it('rejects references that the catalog model does not support', () => {
    const textOnlyImageModel = {
      ...remoteImageModel,
      inputs: { ...remoteImageModel.inputs, imageReferences: null },
    };
    const draft = {
      ...createDefaultCreationDraft('image'),
      model: remoteImageModel.id as 'nano-banana-2',
      prompt: 'A text-only model test',
      aspectRatio: '2:3',
      resolution: '2K' as '1K',
      references: [{
        id: 'ref-1',
        url: 'https://example.com/ref.jpg',
        kind: 'image' as const,
        fileName: 'ref.jpg',
        displayName: 'Reference',
        handle: '@reference',
      }],
    };

    expect(validateCatalogCreationDraft(draft, textOnlyImageModel).errors).toContain(
      'Remote Image V1 does not support image references.'
    );
  });

  it('selects the catalog default when a retired model is absent', () => {
    const catalog = createTestGenerationModelCatalog();
    expect(catalog.models.some((model) => model.id === 'retired-image')).toBe(false);
    expect(catalog.defaults.image).toBe('nano-banana-2');
  });

  it('includes Gemini prepared voice and character IDs in quotes and generation payloads', () => {
    const baseVideoModel = createTestGenerationModelCatalog().models.find((model) => model.kind === 'video');
    if (!baseVideoModel) throw new Error('Expected a video model fixture.');
    const geminiModel = {
      ...baseVideoModel,
      id: 'gemini-omni-video',
      displayName: 'Gemini Omni Video',
      inputs: {
        ...baseVideoModel.inputs,
        imageReferences: { max: 7, supportsNaming: true },
        videoReferences: { max: 1 },
        audioReferences: null,
        preparedAudioReferences: { max: 3 },
        characterReferences: { max: 3 },
        startFrame: false,
        endFrame: false,
      },
    };
    const draft = {
      ...createDefaultCreationDraft('video'),
      model: 'gemini-omni-video' as const,
      prompt: 'Keep the prepared voice and character consistent.',
      referenceMode: 'elements' as const,
      preparedAudioIds: ['voice-prepared-1'],
      characterIds: ['character-prepared-1'],
    };

    expect(buildCatalogQuoteRequest(draft, geminiModel, 'revision-1')).toMatchObject({
      inputCounts: { preparedAudios: 1, characters: 1 },
    });
    expect(buildCatalogGenerationPayload(draft, geminiModel, 'revision-1')).toMatchObject({
      preparedAudioIds: ['voice-prepared-1'],
      characterIds: ['character-prepared-1'],
    });
  });

  it('treats prepared references missing from a legacy video draft as empty arrays', () => {
    const baseVideoModel = createTestGenerationModelCatalog().models.find((model) => model.kind === 'video');
    if (!baseVideoModel) throw new Error('Expected a video model fixture.');
    const geminiModel = {
      ...baseVideoModel,
      id: 'gemini-omni-video',
      displayName: 'Gemini Omni Video',
      inputs: {
        ...baseVideoModel.inputs,
        imageReferences: { max: 7, supportsNaming: true },
        videoReferences: { max: 1 },
        preparedAudioReferences: { max: 3 },
        characterReferences: { max: 3 },
        startFrame: false,
        endFrame: false,
      },
    };
    const legacyDraft = {
      ...createDefaultCreationDraft('video'),
      model: 'gemini-omni-video',
      prompt: 'Create a safe legacy draft.',
      referenceMode: 'elements',
      preparedAudioIds: undefined,
      characterIds: undefined,
    } as unknown as VideoCreationDraft;

    expect(() => buildCatalogQuoteRequest(legacyDraft, geminiModel, 'revision-1')).not.toThrow();
    expect(buildCatalogQuoteRequest(legacyDraft, geminiModel, 'revision-1')).toMatchObject({
      inputCounts: { preparedAudios: 0, characters: 0 },
    });
    expect(applyCatalogModelDefaults(legacyDraft, geminiModel)).toMatchObject({
      preparedAudioIds: [],
      characterIds: [],
    });
    expect(buildCatalogGenerationPayload(legacyDraft, geminiModel, 'revision-1')).toMatchObject({
      preparedAudioIds: [],
      characterIds: [],
    });
  });

  it('persists a reference mode supported by frame-only and reusable-only catalog models', () => {
    const baseVideoModel = createTestGenerationModelCatalog().models.find((model) => model.kind === 'video');
    if (!baseVideoModel) throw new Error('Expected a video model fixture.');
    const startFrame = createMediaDraftFromUpload({
      signedUrl: 'https://cdn.example.com/start.jpg',
      storagePath: 'uploads/user/start.jpg',
      mimeType: 'image/jpeg',
      fileName: 'start.jpg',
      kind: 'image',
    }, { displayName: 'Start frame' });
    const frameDraft = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      prompt: 'Animate from the opening frame.',
      referenceMode: 'elements',
      startFrame,
    }, baseVideoModel);
    if (frameDraft.tool !== 'video') throw new Error('Expected a video draft.');

    expect(frameDraft.referenceMode).toBe('frames');
    expect(buildCatalogQuoteRequest(frameDraft, baseVideoModel, 'revision-1')).toMatchObject({
      settings: { referenceMode: 'frames' },
      inputCounts: { images: 1, videos: 0 },
    });
    expect(buildCatalogGenerationPayload(frameDraft, baseVideoModel, 'revision-1')).toMatchObject({
      referenceMode: 'frames',
      startImageUrl: 'https://cdn.example.com/start.jpg',
      referenceVideoUrls: [],
    });

    const videoReferenceModel = {
      ...baseVideoModel,
      id: 'video-reference-only',
      displayName: 'Video Reference Only',
      inputs: {
        ...baseVideoModel.inputs,
        imageReferences: null,
        videoReferences: { max: 1 },
        startFrame: false,
        endFrame: false,
      },
    };
    const videoReference = createMediaDraftFromUpload({
      signedUrl: 'https://cdn.example.com/reference.mp4',
      storagePath: 'uploads/user/reference.mp4',
      mimeType: 'video/mp4',
      fileName: 'reference.mp4',
      kind: 'video',
    }, { displayName: 'Motion reference' });
    const reusableDraft = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      prompt: 'Follow the attached motion.',
      referenceMode: 'frames',
      referenceVideos: [videoReference],
    }, videoReferenceModel);
    if (reusableDraft.tool !== 'video') throw new Error('Expected a video draft.');

    expect(reusableDraft.referenceMode).toBe('elements');
    expect(buildCatalogQuoteRequest(reusableDraft, videoReferenceModel, 'revision-1')).toMatchObject({
      settings: { referenceMode: 'elements' },
      inputCounts: { images: 0, videos: 1 },
    });
    expect(buildCatalogGenerationPayload(reusableDraft, videoReferenceModel, 'revision-1')).toMatchObject({
      referenceMode: 'elements',
      startImageUrl: null,
      referenceVideoUrls: ['https://cdn.example.com/reference.mp4'],
    });
  });

  it('forces multi-shot catalog drafts into frame mode before quoting and generation', () => {
    const baseVideoModel = createTestGenerationModelCatalog().models.find((model) => model.kind === 'video');
    if (!baseVideoModel) throw new Error('Expected a video model fixture.');
    const multiShotModel = {
      ...baseVideoModel,
      id: 'multi-shot-video',
      displayName: 'Multi-shot Video',
      capabilities: { ...baseVideoModel.capabilities, multiShot: true },
      inputs: {
        ...baseVideoModel.inputs,
        imageReferences: { max: 3, supportsNaming: true },
      },
    };
    const startFrame = createMediaDraftFromUpload({
      signedUrl: 'https://cdn.example.com/multi-start.jpg',
      storagePath: 'uploads/user/multi-start.jpg',
      mimeType: 'image/jpeg',
      fileName: 'multi-start.jpg',
      kind: 'image',
    }, { displayName: 'Multi-shot start' });
    const reusableReference = createMediaDraftFromUpload({
      signedUrl: 'https://cdn.example.com/product.jpg',
      storagePath: 'uploads/user/product.jpg',
      mimeType: 'image/jpeg',
      fileName: 'product.jpg',
      kind: 'image',
    }, { displayName: 'Product' });
    const endFrame = createMediaDraftFromUpload({
      signedUrl: 'https://cdn.example.com/multi-end.jpg',
      storagePath: 'uploads/user/multi-end.jpg',
      mimeType: 'image/jpeg',
      fileName: 'multi-end.jpg',
      kind: 'image',
    }, { displayName: 'Multi-shot end' });
    const normalized = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      isMultiShot: true,
      referenceMode: 'elements',
      references: [reusableReference],
      startFrame,
      endFrame,
    }, multiShotModel);
    if (normalized.tool !== 'video') throw new Error('Expected a video draft.');

    expect(normalized).toMatchObject({ isMultiShot: true, referenceMode: 'frames', endFrame: null });
    expect(buildCatalogQuoteRequest(normalized, multiShotModel, 'revision-1')).toMatchObject({
      settings: { referenceMode: 'frames' },
      inputCounts: { images: 1 },
    });
    expect(buildCatalogGenerationPayload(normalized, multiShotModel, 'revision-1')).toMatchObject({
      referenceMode: 'frames',
      elementImageUrls: [],
      startImageUrl: 'https://cdn.example.com/multi-start.jpg',
      endImageUrl: null,
      endFrame: null,
    });
  });

  it('maps Kling reusable videos to named Kling elements instead of generic video URLs', () => {
    const baseVideoModel = createTestGenerationModelCatalog().models.find((model) => model.kind === 'video');
    if (!baseVideoModel) throw new Error('Expected a video model fixture.');
    const klingModel = {
      ...baseVideoModel,
      id: 'kling-3.0-video',
      displayName: 'Kling 3.0 Cinematic',
      inputs: {
        ...baseVideoModel.inputs,
        videoReferences: { max: 3 },
      },
    };
    const referenceVideo = {
      ...createMediaDraftFromUpload({
        signedUrl: 'https://cdn.example.com/product-turn.mp4',
        storagePath: 'uploads/user/product-turn.mp4',
        mimeType: 'video/mp4',
        fileName: 'product-turn.mp4',
        kind: 'video',
      }, { displayName: 'Product turn' }),
      handle: '@product_turn',
    };
    const draft = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      model: 'kling-3.0-video',
      prompt: 'Match @product_turn in a cinematic reveal.',
      referenceMode: 'elements',
      referenceVideos: [referenceVideo],
    }, klingModel);
    if (draft.tool !== 'video') throw new Error('Expected a video draft.');

    expect(buildCatalogQuoteRequest(draft, klingModel, 'revision-1')).toMatchObject({
      inputCounts: { videos: 1 },
    });
    expect(validateCatalogCreationDraft(draft, klingModel, { credits: 100, quotedCost: 8 }).errors).toEqual([]);
    expect(buildCatalogGenerationPayload(draft, klingModel, 'revision-1')).toMatchObject({
      referenceVideoUrls: [],
      klingVideoElements: [{
        id: referenceVideo.id,
        url: 'https://cdn.example.com/product-turn.mp4',
        handle: '@product_turn',
        displayName: 'Product turn',
        storagePath: 'uploads/user/product-turn.mp4',
      }],
    });
  });

  it('keeps Wan first-frame guidance alongside reusable references', () => {
    const baseVideoModel = createTestGenerationModelCatalog().models.find((model) => model.kind === 'video');
    if (!baseVideoModel) throw new Error('Expected a video model fixture.');
    const wanModel = {
      ...baseVideoModel,
      id: 'wan-2.7',
      displayName: 'Wan 2.7',
      inputs: {
        ...baseVideoModel.inputs,
        imageReferences: { max: 5, supportsNaming: true },
        videoReferences: { max: 3 },
        audioReferences: { max: 1 },
        combineFramesWithReferences: true,
        endFrame: false,
      },
    };
    const startFrame = createMediaDraftFromUpload({
      signedUrl: 'https://cdn.example.com/first-frame.jpg',
      storagePath: 'uploads/user/first-frame.jpg',
      mimeType: 'image/jpeg',
      fileName: 'first-frame.jpg',
      kind: 'image',
    }, { displayName: 'First frame' });
    const draft = {
      ...createDefaultCreationDraft('video'),
      model: 'wan-2.7' as const,
      prompt: 'Keep the product consistent from this opening frame.',
      referenceMode: 'elements' as const,
      startFrame,
    };

    const normalized = applyCatalogModelDefaults(draft, wanModel);
    if (normalized.tool !== 'video') throw new Error('Expected a video draft.');

    expect(normalized).toMatchObject({ referenceMode: 'elements', startFrame });
    expect(buildCatalogGenerationPayload(normalized, wanModel, 'revision-1')).toMatchObject({
      referenceMode: 'elements',
      startImageUrl: 'https://cdn.example.com/first-frame.jpg',
      startFrame: { storagePath: 'uploads/user/first-frame.jpg' },
    });
  });
});
