import { describe, expect, it } from 'vitest';

import subjectsContract from '../../contracts/model-catalog-subjects-mode-v1.json';
import type {
  CatalogControl,
  CatalogInputMode,
  CatalogInputSlot,
  GenerationModelDescriptor,
} from '../lib/generation-model-catalog';
import { normalizeCatalogSettings, parseModelCatalogDetail } from '../lib/generation-model-catalog';
import {
  applyCatalogModelDefaults,
  catalogDraftInputCounts,
  catalogDraftRunHandles,
  catalogMultiShotLimits,
  catalogPromptLimitError,
  catalogPromptMeters,
  catalogRunEnhancementInputs,
  catalogRunInputSlots,
  catalogStandbyReferencesReason,
  catalogVideoRunReferenceMode,
  reconcileCreationDraftWithCatalog,
  videoSettingsHiddenControlKeys,
  buildCatalogGenerationPayload,
  buildCatalogQuoteRequest,
  buildUnifiedCatalogGenerationRequest,
  catalogStartRequest,
  getCatalogCreationSectionSummary,
  getCatalogDraftSettings,
  hydrateCatalogCreationDraftFromRemixSource,
  multiShotTotalDuration,
  validateCatalogCreationDraft,
} from '../lib/generation-model-draft';
import {
  buildPromptEnhancementRequest,
  createDefaultCreationDraft,
  createMediaDraftFromUpload,
  createSubjectDraft,
  renameMediaDraft,
  videoDraftReferenceMode,
  type ImageCreationDraft,
  type MediaDraft,
  type VideoCreationDraft,
  type VideoShotDraft,
} from '../lib/media-creation-view-model';
import type { SeedanceAssetMetadata } from '../lib/model-catalog/seedance-assets';
import type { RemixSourceBundle } from '../lib/types';
import { createRemixRestoreCatalog, createTestGenerationModelCatalog, remoteImageModel, seedance15ProModel, veo31Model } from './fixtures/generation-model-catalog';
import liveCatalog from './fixtures/live-catalog-descriptors.json';
import { klingVideoModel, remoteVideoModel } from './generation-model-catalog-v2-fixtures';

describe('catalog-backed mobile creation drafts', () => {
  it('applies remote model defaults without bundled model data, and keeps references past the model limit', () => {
    const draft = createDefaultCreationDraft('image');
    const references = Array.from({ length: 5 }, (_, index) => ({
      id: `ref-${index}`,
      url: `https://example.com/${index}.jpg`,
      kind: 'image' as const,
      fileName: `${index}.jpg`,
      displayName: `Reference ${index}`,
      handle: `@reference_${index}`,
    }));
    const normalized = applyCatalogModelDefaults({
      ...draft,
      model: remoteImageModel.id as typeof draft.model,
      prompt: 'Five bottles on a shelf.',
      references,
    }, remoteImageModel) as ImageCreationDraft;

    expect(normalized).toMatchObject({ model: 'remote-image-v1', aspectRatio: '2:3', resolution: '2K' });
    // The model takes 3. The other 2 used to be deleted here, for good: picking a model
    // that takes them all did not bring them back.
    expect(normalized.references).toHaveLength(5);
    expect(validateCatalogCreationDraft(normalized, remoteImageModel, { credits: 10, quotedCost: 6 }).errors)
      .toEqual(['Remote Image V1 supports up to 3 total reference images.']);
    expect(buildCatalogQuoteRequest(normalized, remoteImageModel, 'revision-1').inputCounts.images).toBe(3);
    expect(buildCatalogGenerationPayload(normalized, remoteImageModel, 'revision-1').imageUrls)
      .toEqual(references.slice(0, 3).map((reference) => reference.url));
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

  it('preserves the draft when a retired model is absent', () => {
    const catalog = createTestGenerationModelCatalog();
    const draft = { ...createDefaultCreationDraft('image'), model: 'retired-image', prompt: 'Keep this prompt' };
    const result = reconcileCreationDraftWithCatalog(draft, catalog);
    expect(result.draft).toEqual(draft);
    expect(result.model).toBeNull();
    expect(result.switchedModel).toBe(false);
    expect(result.warning).toContain('Choose a replacement');
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

/**
 * The check read a prompt's mentions with a pattern of its own, /@[a-z0-9_]+/gi,
 * and not the one the server reads a prompt with (HANDLE_PATTERN in
 * src/lib/image-elements.ts, kept for mobile in lib/media-creation-view-model.ts).
 * It took a word with a capital ("@Nike") and the end of an address
 * ("studio@example.com") for mentions, found no reference under either, and
 * refused a prompt the server accepts as it stands (2026-10-03).
 */
describe('Seedance assets in a catalog payload', () => {
  const upload = (fileName: string, kind: 'image' | 'video' | 'audio') => createMediaDraftFromUpload({
    signedUrl: `https://cdn.example.com/${fileName}`,
    storagePath: `uploads/user/${fileName}`,
    mimeType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg',
    fileName,
    kind,
  }, { displayName: fileName.replace(/\..+$/, '') });
  const seedance = createRemixRestoreCatalog().models.find((model) => model.id === 'seedance-2');
  if (!seedance) throw new Error('Expected the Seedance 2 fixture.');
  const activeAsset = { assetId: 'asset-hero', assetType: 'Image' as const, status: 'active' as const, sourceUrl: 'https://cdn.example.com/hero.png', error: null, lastCheckedAt: '2026-10-08T00:00:00.000Z' };
  const processingAsset = { assetId: 'asset-voice', assetType: 'Audio' as const, status: 'processing' as const, sourceUrl: null, error: null, lastCheckedAt: '2026-10-08T00:00:00.000Z' };

  it('sends a prepared asset in place of its link, and tells the server what each reference had prepared', () => {
    // Mirrors the web creator: an active asset's id replaces the link; a reference
    // still processing, or never prepared, goes as its link; and every reusable
    // reference is listed in `seedanceAssets` by index so a remix restores the ids.
    const draft = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      model: 'seedance-2',
      prompt: 'The product from @hero spins.',
      referenceMode: 'elements',
      references: [{ ...upload('hero.png', 'image'), seedanceAsset: activeAsset }],
      referenceVideos: [upload('motion.mp4', 'video')],
      referenceAudios: [{ ...upload('voice.mp3', 'audio'), seedanceAsset: processingAsset }],
    }, seedance);
    if (draft.tool !== 'video') throw new Error('Expected a video draft.');

    expect(buildCatalogGenerationPayload(draft, seedance, 'revision-1')).toMatchObject({
      imageUrls: ['asset-hero'],
      elementImageUrls: ['asset-hero'],
      referenceVideoUrls: ['https://cdn.example.com/motion.mp4'],
      referenceAudioUrls: ['https://cdn.example.com/voice.mp3'],
      seedanceAssets: {
        images: [{ assetId: 'asset-hero', assetType: 'Image', status: 'active', sourceUrl: 'https://cdn.example.com/hero.png' }],
        videos: [{ assetId: null, assetType: 'Video', status: 'idle', sourceUrl: 'https://cdn.example.com/motion.mp4' }],
        audios: [{ assetId: 'asset-voice', assetType: 'Audio', status: 'processing', sourceUrl: 'https://cdn.example.com/voice.mp3' }],
      },
    });
  });

  it('sends links and no asset collections to a model outside the Seedance 2 family, whatever a reference carries', () => {
    const other = { ...seedance, id: 'other-video', displayName: 'Other video' };
    const draft = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      model: 'other-video',
      prompt: 'The product from @hero spins.',
      referenceMode: 'elements',
      references: [{ ...upload('hero.png', 'image'), seedanceAsset: activeAsset }],
    }, other);
    if (draft.tool !== 'video') throw new Error('Expected a video draft.');

    expect(buildCatalogGenerationPayload(draft, other, 'revision-1')).toMatchObject({
      imageUrls: ['https://cdn.example.com/hero.png'],
      elementImageUrls: ['https://cdn.example.com/hero.png'],
      seedanceAssets: null,
    });
  });

  it('sends links and no asset collections for a frames run of a Seedance model', () => {
    const draft = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      model: 'seedance-2',
      prompt: 'Animate from the opening frame.',
      referenceMode: 'frames',
      startFrame: { ...upload('start.png', 'image'), seedanceAsset: activeAsset },
    }, seedance);
    if (draft.tool !== 'video') throw new Error('Expected a video draft.');

    expect(buildCatalogGenerationPayload(draft, seedance, 'revision-1')).toMatchObject({
      startImageUrl: 'https://cdn.example.com/start.png',
      seedanceAssets: null,
    });
  });
});

describe('the mentions a catalog draft is checked for', () => {
  const product = {
    id: 'ref-product',
    url: 'https://example.com/product.jpg',
    kind: 'image' as const,
    fileName: 'product.jpg',
    displayName: 'Product',
    handle: '@product',
  };
  const validate = (prompt: string) => validateCatalogCreationDraft({
    ...createDefaultCreationDraft('image'),
    model: remoteImageModel.id as 'nano-banana-2',
    prompt,
    aspectRatio: '2:3',
    resolution: '2K' as '1K',
    references: [product],
  }, remoteImageModel, { credits: 10, quotedCost: 6 });

  it('accepts a mention of a reference the draft holds', () => {
    expect(validate('Put @product on a marble counter, then (@product) again.'))
      .toMatchObject({ errors: [], canGenerate: true });
  });

  it('refuses a mention of a reference the draft does not hold, and names it once', () => {
    expect(validate('Put @product beside @missing, then @missing again.').errors)
      .toEqual(['Unknown element mention: @missing']);
    expect(validate('Swap @lost for @missing.').errors)
      .toEqual(['Unknown element mentions: @lost, @missing']);
  });

  it('leaves a word with a capital as the text it is, which is how a prompt names an account or a brand', () => {
    expect(validate('A runner in the style of @Nike, shot for @MrBeast'))
      .toMatchObject({ errors: [], canGenerate: true });
  });

  it('reads no mention in an address or in a word that only contains "@"', () => {
    expect(validate('write to studio@example.com, or a@b'))
      .toMatchObject({ errors: [], canGenerate: true });
  });

  it('names only the mentions the server would refuse too', () => {
    expect(validate('Put @product beside @missing for @Nike, and write to studio@example.com').errors)
      .toEqual(['Unknown element mention: @missing']);
  });

  it('takes a handle the draft holds, written with a capital, for text as the server does', () => {
    // To the server "@Product" is not the handle "@product": it reads no mention
    // there and sends the prompt as written. The "@" panel is how a creator gets
    // the handle right, and it replaces what was typed with the handle it inserts.
    expect(validate('Put @Product on a marble counter').errors).toEqual([]);
  });

  // The server reads a run's prompt for mentions when it is an image prompt or a
  // single-shot video prompt (startImageGeneration and startVideoGeneration in
  // src/lib/generation-services.ts). It reads none in a motion prompt, and in a
  // multi-shot run it reads the shots, not the prompt. The check read every
  // draft's prompt: a motion prompt, where no reference exists to answer a
  // mention, and the prompt a multi-shot draft keeps behind its shot editor.
  it('reads none in a motion prompt, which has no reference to name', () => {
    const motionModel = createTestGenerationModelCatalog().models.find((model) => model.id === 'kling-3.0');
    if (!motionModel) throw new Error('Expected a motion model fixture.');
    const draft = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('motion'),
      prompt: 'Match the timing of @dancer, eyes to camera.',
      characterImage: createMediaDraftFromUpload({
        signedUrl: 'https://cdn.example.com/character.jpg',
        storagePath: 'uploads/user/character.jpg',
        mimeType: 'image/jpeg',
        fileName: 'character.jpg',
        kind: 'image',
      }, { displayName: 'Character' }),
      referenceVideo: createMediaDraftFromUpload({
        signedUrl: 'https://cdn.example.com/dance.mp4',
        storagePath: 'uploads/user/dance.mp4',
        mimeType: 'video/mp4',
        fileName: 'dance.mp4',
        kind: 'video',
        durationSeconds: 8,
      }, { displayName: 'Dance' }),
    }, motionModel);

    expect(validateCatalogCreationDraft(draft, motionModel, { credits: 100, quotedCost: 8 }))
      .toMatchObject({ errors: [], canGenerate: true });
  });

  it('reads none in the prompt a multi-shot draft keeps but does not show', () => {
    const baseVideoModel = createTestGenerationModelCatalog().models.find((model) => model.kind === 'video');
    if (!baseVideoModel) throw new Error('Expected a video model fixture.');
    const multiShotModel = {
      ...baseVideoModel,
      id: 'multi-shot-video',
      displayName: 'Multi-shot Video',
      capabilities: { ...baseVideoModel.capabilities, multiShot: true },
    };
    // Written as a single shot, then switched: the shot editor takes the prompt's
    // place on screen, and the server reads the shots.
    const singleShot = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      prompt: 'Open on @ghost in the rain.',
      multiPrompts: [
        { id: 'shot-1', prompt: 'A street at night.', duration: 5 },
        { id: 'shot-2', prompt: 'She turns to the camera.', duration: 5 },
      ],
    }, multiShotModel);
    if (singleShot.tool !== 'video') throw new Error('Expected a video draft.');
    const quote = { credits: 100, quotedCost: 8 };

    expect(validateCatalogCreationDraft(singleShot, multiShotModel, quote).errors)
      .toEqual(['Unknown element mention: @ghost']);
    expect(validateCatalogCreationDraft({ ...singleShot, isMultiShot: true }, multiShotModel, quote))
      .toMatchObject({ errors: [], canGenerate: true });
  });
});

// Descriptors in the shape the server builds them (imageInputModes and videoInputModes in
// src/lib/generation-model-catalog.ts), for the rules that read a model's input modes.
const byReferenceMode = (value: 'frames' | 'elements') => ({
  source: 'setting' as const,
  key: 'referenceMode',
  operator: 'equals' as const,
  value,
});
const startFrameSlot: CatalogInputSlot = { key: 'startFrame', kind: 'image', role: 'startFrame', label: 'Start frame', min: 0, max: 1 };
const endFrameSlot: CatalogInputSlot = { key: 'endFrame', kind: 'image', role: 'endFrame', label: 'End frame', min: 0, max: 1 };
const framesMode = (slots: CatalogInputSlot[] = [startFrameSlot, endFrameSlot]): CatalogInputMode => ({
  key: 'frames',
  label: 'Frames',
  default: true,
  conditions: [byReferenceMode('frames')],
  slots,
});
const referencesMode = (slots: CatalogInputSlot[]): CatalogInputMode => ({
  key: 'references',
  label: 'Reusable references',
  default: false,
  conditions: [byReferenceMode('elements')],
  slots,
});
const imageReferencesSlot = (max: number, extra: Partial<CatalogInputSlot> = {}): CatalogInputSlot => ({
  key: 'imageReferences', kind: 'image', role: 'reference', label: 'Reference images', min: 0, max, supportsNaming: true, ...extra,
});
const choice = (key: string, label: string, values: string[], defaultValue = values[0]): CatalogControl => ({
  key, label, type: 'choice', presentation: 'chips', defaultValue, options: values.map((value) => ({ value, label: value })),
});
const toggle = (key: string, label: string): CatalogControl => ({ key, label, type: 'boolean', presentation: 'toggle', defaultValue: false });
const seconds = (min: number, max: number, defaultValue: number): CatalogControl => ({
  key: 'duration', label: 'Duration', type: 'integer', presentation: 'stepper', defaultValue, min, max, step: 1, unit: 'seconds',
});
const noLegacyInputs: GenerationModelDescriptor['inputs'] = {
  imageReferences: null,
  videoReferences: null,
  audioReferences: null,
  preparedAudioReferences: null,
  characterReferences: null,
  startFrame: false,
  endFrame: false,
  combineFramesWithReferences: false,
};

function imageModelWithSlots(id: string, displayName: string, maxImages: number): GenerationModelDescriptor {
  return {
    ...remoteImageModel,
    id,
    displayName,
    inputs: { ...noLegacyInputs, imageReferences: maxImages > 0 ? { max: maxImages, supportsNaming: true } : null },
    inputModes: maxImages > 0
      ? [{ key: 'references', label: 'Reference images', default: true, slots: [imageReferencesSlot(maxImages)] }]
      : [{ key: 'prompt-only', label: 'Prompt only', default: true, slots: [] }],
    inputConstraints: [],
  };
}

const kling30 = klingVideoModel();

const klingO3 = remoteVideoModel('kling-o3', {
  displayName: 'Kling O3',
  controls: [
    choice('aspectRatio', 'Aspect ratio', ['16:9', '9:16', '1:1']),
    seconds(3, 15, 5),
    toggle('sound', 'Sound'),
    toggle('isMultiShot', 'Multi-shot'),
    choice('referenceMode', 'Input mode', ['frames', 'elements']),
  ],
  capabilities: { multiShot: true, sound: true, fixedLens: false, googleSearch: false, outputFormat: false },
  inputs: { ...noLegacyInputs, imageReferences: { max: 7, supportsNaming: true }, startFrame: true },
  inputModes: [
    framesMode([startFrameSlot]),
    referencesMode([imageReferencesSlot(7, { maxNamed: 3 })]),
    subjectsContract.inputMode as CatalogInputMode,
  ],
  inputConstraints: [],
});

const seedance2 = remoteVideoModel('seedance-2', {
  displayName: 'Seedance 2',
  controls: [
    choice('aspectRatio', 'Aspect ratio', ['16:9', '9:16', '1:1']),
    choice('resolution', 'Resolution', ['480p', '720p', '1080p']),
    seconds(4, 15, 15),
    toggle('sound', 'Sound'),
    choice('referenceMode', 'Input mode', ['frames', 'elements']),
  ],
  capabilities: { multiShot: false, sound: true, fixedLens: false, googleSearch: false, outputFormat: false },
  inputs: {
    ...noLegacyInputs,
    imageReferences: { max: 5, supportsNaming: true },
    videoReferences: { max: 3 },
    audioReferences: { max: 3 },
    startFrame: true,
    endFrame: true,
  },
  inputModes: [
    framesMode(),
    referencesMode([
      imageReferencesSlot(5),
      { key: 'videoReferences', kind: 'video', role: 'reference', label: 'Reference videos', min: 0, max: 3, durationMetadata: 'required', maxDurationSeconds: 15 },
      { key: 'audioReferences', kind: 'audio', role: 'reference', label: 'Reference audio', min: 0, max: 3, durationMetadata: 'optional', maxDurationSeconds: 15 },
    ]),
  ],
  inputConstraints: [{ type: 'combined-duration', slotKeys: ['videoReferences'], max: 15, message: 'Reference videos may be at most 15 seconds in total.' }],
});

function upload(fileName: string, kind: 'image' | 'video' | 'audio', extra: { durationSeconds?: number } = {}): MediaDraft {
  return createMediaDraftFromUpload({
    signedUrl: `https://cdn.example.com/${fileName}`,
    storagePath: `uploads/user/${fileName}`,
    mimeType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg',
    fileName,
    kind,
    ...extra,
  }, { displayName: fileName.replace(/\..+$/, '') });
}

function videoDraft(model: GenerationModelDescriptor, overrides: Partial<VideoCreationDraft> = {}): VideoCreationDraft {
  return applyCatalogModelDefaults({
    ...createDefaultCreationDraft('video'),
    model: model.id,
    prompt: 'A slow push in on the product.',
    ...overrides,
  }, model) as VideoCreationDraft;
}

const ready = { credits: 500, quotedCost: 40 };

describe('references kept across a model change', () => {
  const wide = imageModelWithSlots('wide-image', 'Wide Image', 14);
  const narrow = imageModelWithSlots('narrow-image', 'Narrow Image', 2);
  const promptOnly = imageModelWithSlots('prompt-only-image', 'Prompt Only', 0);
  const references = ['bottle', 'cap', 'label'].map((name) => upload(`${name}.png`, 'image'));

  it('keeps every image reference, sends what each model takes, and blocks the run on an excess', () => {
    const onWide = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('image'),
      model: wide.id,
      prompt: 'Three parts of one bottle on a counter.',
      references,
    }, wide) as ImageCreationDraft;
    const onNarrow = applyCatalogModelDefaults(onWide, narrow) as ImageCreationDraft;

    expect(onNarrow.references).toEqual(references);
    expect(validateCatalogCreationDraft(onNarrow, narrow, ready).errors).toEqual(['Reference images supports up to 2 inputs.']);
    expect(buildCatalogQuoteRequest(onNarrow, narrow, 'revision-1')).toMatchObject({
      inputCounts: { images: 2 },
      inputMetadata: { slots: { imageReferences: { count: 2 } } },
    });
    expect(buildUnifiedCatalogGenerationRequest(onNarrow, narrow, 'revision-1').inputs.map((input) => input.url))
      .toEqual(references.slice(0, 2).map((reference) => reference.url));

    // A prompt-only model has no slot to name; the references wait for the next model.
    const onPromptOnly = applyCatalogModelDefaults(onNarrow, promptOnly) as ImageCreationDraft;
    expect(onPromptOnly.references).toEqual(references);
    expect(validateCatalogCreationDraft(onPromptOnly, promptOnly, ready).errors).toEqual(['Prompt Only does not support image references.']);
    expect(buildCatalogQuoteRequest(onPromptOnly, promptOnly, 'revision-1').inputCounts.images).toBe(0);
    expect(buildUnifiedCatalogGenerationRequest(onPromptOnly, promptOnly, 'revision-1').inputs).toEqual([]);

    const back = applyCatalogModelDefaults(onPromptOnly, wide) as ImageCreationDraft;
    expect(validateCatalogCreationDraft(back, wide, ready)).toMatchObject({ errors: [], canGenerate: true });
    expect(buildUnifiedCatalogGenerationRequest(back, wide, 'revision-1').inputs).toHaveLength(3);
  });

  it('keeps a frames run whole when the pictures it holds are for another model', () => {
    const pictures = [upload('hero.png', 'image'), upload('prop.png', 'image')];
    const start = upload('start.png', 'image');
    const onSeedance = videoDraft(seedance2, { references: pictures });
    expect(onSeedance.referenceMode).toBe('elements');

    const onKling = applyCatalogModelDefaults({ ...onSeedance, startFrame: start }, kling30) as VideoCreationDraft;
    expect(onKling.references).toEqual(pictures);
    expect(onKling.referenceMode).toBe('frames');
    // The screen derives 'elements' from anything attached; the run reads the model.
    const asTheScreenSendsIt: VideoCreationDraft = { ...onKling, referenceMode: 'elements' };
    expect(catalogVideoRunReferenceMode(asTheScreenSendsIt, kling30)).toBe('frames');
    const request = buildUnifiedCatalogGenerationRequest(asTheScreenSendsIt, kling30, 'revision-1');
    expect(request.settings.referenceMode).toBe('frames');
    expect(request.inputs).toEqual([expect.objectContaining({ slot: 'startFrame', url: start.url })]);
    expect(buildCatalogQuoteRequest(asTheScreenSendsIt, kling30, 'revision-1')).toMatchObject({
      settings: { referenceMode: 'frames' },
      inputCounts: { images: 1, videos: 0, audios: 0 },
    });
    expect(validateCatalogCreationDraft(asTheScreenSendsIt, kling30, ready).errors).toEqual([]);
    // The server lets a prompt name only what it is sent, and the pictures are not.
    expect(catalogDraftRunHandles(asTheScreenSendsIt, kling30)).toEqual([]);
    expect(validateCatalogCreationDraft({ ...asTheScreenSendsIt, prompt: 'Then @hero waves.' }, kling30, ready).errors)
      .toEqual(['Unknown element mention: @hero']);

    // Picking Seedance 2 again finds them.
    const back = applyCatalogModelDefaults(onKling, seedance2) as VideoCreationDraft;
    expect(back.referenceMode).toBe('elements');
    expect(buildUnifiedCatalogGenerationRequest(back, seedance2, 'revision-1').inputs.map((input) => input.url))
      .toEqual(pictures.map((picture) => picture.url));
  });

  it('sends Kling 3.0 video elements beside the frames they ride with', () => {
    const start = upload('start.png', 'image');
    const spin = { ...upload('spin.mp4', 'video', { durationSeconds: 4 }), handle: '@spin' };
    const draft = videoDraft(kling30, { prompt: 'Open on the bottle, then @spin.', startFrame: start, referenceVideos: [spin] });

    expect(draft.referenceMode).toBe('frames');
    const request = buildUnifiedCatalogGenerationRequest(draft, kling30, 'revision-1');
    expect(request.inputs.map((input) => input.slot)).toEqual(['startFrame', 'videoElements']);
    expect(request.inputs[1]).toMatchObject({ kind: 'video', url: spin.url, handle: '@spin', durationSeconds: 4 });
    // Priced by what the run sends, as the server counts it: the clip is a video.
    expect(buildCatalogQuoteRequest(draft, kling30, 'revision-1')).toMatchObject({
      inputCounts: { images: 1, videos: 1 },
      inputMetadata: {
        slots: { startFrame: { count: 1 }, videoElements: { count: 1, durationsSeconds: [4] } },
        referenceVideoDurationsSeconds: [4],
      },
    });
    expect(validateCatalogCreationDraft(draft, kling30, ready)).toMatchObject({ errors: [], canGenerate: true });
  });

  // The server takes a Kling 3.0 clip only under a handle (videoElementInputs) and Kling 3.0 reads no
  // plain clip link, so a clip uploaded on Seedance 2 Mini, whose clips take none, and carried onto
  // Kling 3.0 was quoted and shown and then left out of the run it was charged for.
  it('names a clip carried onto Kling 3.0 from a model whose clips take no handle, so its run sends it', () => {
    const clip: MediaDraft = { ...upload('dance.mp4', 'video', { durationSeconds: 6 }), displayName: 'Reference Video' };
    const onSeedance = videoDraft(seedance2, { prompt: 'The dancer spins.', referenceVideos: [clip] });
    expect(onSeedance.referenceVideos[0].handle).toBeUndefined();

    const onKling = applyCatalogModelDefaults(onSeedance, kling30) as VideoCreationDraft;

    expect(buildUnifiedCatalogGenerationRequest(onKling, kling30, 'revision-1').inputs).toEqual([
      expect.objectContaining({ slot: 'videoElements', url: clip.url, handle: '@reference_video', durationSeconds: 6 }),
    ]);
    expect(onKling.prompt).toBe('The dancer spins.');
    expect(catalogDraftRunHandles(onKling, kling30)).toEqual(['@reference_video']);
    expect(validateCatalogCreationDraft(onKling, kling30, ready)).toMatchObject({ errors: [], canGenerate: true });
  });

  // A valid handle is kept as the web keeps one (assignElementHandles). The rest are made by the app's own
  // rule, which the web does not share: past every handle the draft holds and every one its words mention,
  // and marked as made up, so a remix's recovery may still give the clip its source's in their place.
  it('keeps a clip a valid handle of its own, and makes the rest past every handle the draft holds or its words mention', () => {
    const clip = (name: string, displayName: string, handle?: string): MediaDraft => ({
      ...upload(`${name}.mp4`, 'video', { durationSeconds: 4 }), displayName, handle,
    });

    // A second @spin, and one no prompt could mention, are made from their names.
    const renamed = videoDraft(kling30, { prompt: 'Start on @spin.', referenceVideos: [clip('spin', 'Spin', '@spin'), clip('again', 'Spin', '@spin'), clip('loud', 'Loud Move', '@Loud Move')] });
    expect(renamed.referenceVideos.map((item) => [item.handle, item.handleStandIn])).toEqual([
      ['@spin', undefined],
      ['@spin_2', true],
      ['@loud_move', true],
    ]);

    // Past a picture's handle, a subject's and the ones the words mention, which stay as they are; a name
    // with nothing a handle can hold makes the generic one.
    const prompt = 'Then @reference_video_3 and @someone.';
    const crowded = videoDraft(kling30, {
      prompt,
      references: [{ ...upload('poster.png', 'image'), displayName: 'Reference Video', handle: '@reference_video' }],
      subjects: [createSubjectDraft([upload('hero.png', 'image')], 'Reference Video', ['@reference_video'])],
      referenceVideos: [clip('dance', 'Reference Video'), clip('blank', '')],
    });
    expect(crowded.subjects?.[0].handle).toBe('@reference_video_2');
    expect(crowded.referenceVideos.map((item) => item.handle)).toEqual(['@reference_video_4', '@element']);
    expect(crowded.prompt).toBe(prompt);

    // Named once, a clip keeps its handle: the draft read again, and on a model whose clips take none and back.
    expect((applyCatalogModelDefaults(renamed, kling30) as VideoCreationDraft).referenceVideos).toBe(renamed.referenceVideos);
    const onSeedance = applyCatalogModelDefaults(renamed, seedance2) as VideoCreationDraft;
    expect(onSeedance.referenceVideos).toBe(renamed.referenceVideos);
    expect((applyCatalogModelDefaults(onSeedance, kling30) as VideoCreationDraft).referenceVideos.map((item) => item.handle))
      .toEqual(['@spin', '@spin_2', '@loud_move']);
    // A clip that joins them without a handle of its own (carried over, restored) is named by the same rule,
    // past the handles mentioned. One the creator adds may take a mentioned one: withCreatorClipHandle.
    const added = videoDraft(kling30, { ...renamed, prompt: 'Then @reference_video.', referenceVideos: [...renamed.referenceVideos, clip('new', 'Reference Video')] });
    expect(added.referenceVideos.map((item) => item.handle)).toEqual(['@spin', '@spin_2', '@loud_move', '@reference_video_2']);
    // Renamed, a made-up handle is the creator's.
    expect(renameMediaDraft(added.referenceVideos[1], 'Jump', true)).toMatchObject({ handle: '@jump' });
    expect(renameMediaDraft(added.referenceVideos[1], 'Jump', true).handleStandIn).toBeUndefined();
  });

  // Some paths put a clip in the draft past the normalization that names it: an upload landing through a
  // catalog that has no details for the model it now runs on, or a remix restore merged as it came. Its
  // run still sends it, under a handle made by the same rule.
  it('sends a clip that reached the run without a handle under one made as the draft would name it', () => {
    const clip: MediaDraft = { ...upload('late.mp4', 'video', { durationSeconds: 5 }), displayName: 'Reference Video' };
    const unnamed: VideoCreationDraft = { ...videoDraft(kling30), prompt: 'Then @reference_video jumps.', referenceVideos: [clip] };

    expect(buildUnifiedCatalogGenerationRequest(unnamed, kling30, 'revision-1').inputs).toEqual([
      expect.objectContaining({ slot: 'videoElements', url: clip.url, handle: '@reference_video_2' }),
    ]);
  });
});

// Kie's kling-3.0/video refuses a video element shorter than 3 seconds, and the server's start
// refused such a run (before any hold) only once Generate was pressed. The catalog publishes the
// slot's shortest clip (`minDurationSeconds`, release kling-element-min-duration-20261030), and the
// run waits on it in the start's own words, so the creator learns it before Generate.
describe('a clip shorter than its slot takes', () => {
  const clip = (seconds: number | undefined, name = 'wave') => ({
    ...upload(`${name}.mp4`, 'video', seconds === undefined ? {} : { durationSeconds: seconds }),
    handle: `@${name}`,
  });

  it('holds a Kling 3.0 run whose video element is under 3 seconds, naming the clip and its length', () => {
    const draft = videoDraft(kling30, { prompt: 'Open on @wave, then @spin.', referenceVideos: [clip(4, 'spin'), clip(2.16)] });

    expect(validateCatalogCreationDraft(draft, kling30, ready)).toMatchObject({
      // The start's words (referenceMediaLengthViolation in src/lib/provider-input-limits.ts), naming the
      // clip by its handle: every clip the app picks is called "Reference Video".
      errors: ['Kling 3.0 Cinematic video elements must be at least 3 seconds long. @wave runs 2.1 seconds.'],
      canGenerate: false,
    });
  });

  it('lets a clip of 3 seconds or more go, one just under that the start may still take, and one of no known length', () => {
    // The start reads ffmpeg's length to the hundredth (2.996 s is 3 s to it), and the phone's reading of a
    // trimmed clip can fall a frame short of it: the app holds only a clip short by more than that.
    for (const seconds of [3, 3.4, 2.996, 2.95, undefined]) {
      const draft = videoDraft(kling30, { prompt: 'Open on @wave.', referenceVideos: [clip(seconds)] });
      expect(validateCatalogCreationDraft(draft, kling30, ready), String(seconds)).toMatchObject({ errors: [], canGenerate: true });
    }
  });

  it('says nothing on a descriptor that publishes no minimum, as production did before the release', () => {
    const unpublished = klingVideoModel();
    for (const mode of unpublished.inputModes ?? []) {
      for (const slot of mode.slots) delete slot.minDurationSeconds;
    }
    const draft = videoDraft(unpublished, { prompt: 'Open on @wave.', referenceVideos: [clip(2.16)] });

    expect(validateCatalogCreationDraft(draft, unpublished, ready)).toMatchObject({ errors: [], canGenerate: true });
  });

  it('holds only the clips the run sends to the minimum', () => {
    // A fourth clip waits past the slot's three, and the line about the excess is the one that holds the run.
    const clips = [clip(4, 'one'), clip(5, 'two'), clip(6, 'three'), clip(1.2, 'four')];
    const draft = videoDraft(kling30, { prompt: 'Open on @one.', referenceVideos: clips });

    expect(validateCatalogCreationDraft(draft, kling30, ready).errors).toEqual(['Video elements supports up to 3 inputs.']);
  });
});

describe('why references a draft holds wait out of its run', () => {
  // As the native parser reads it from the catalog: the reason reads its `in` condition and the labels.
  const veo = parseModelCatalogDetail(veo31Model);
  const pictures = ['hero', 'prop'].map((name) => upload(`${name}.png`, 'image'));
  // The shape a single shot's references rail asks about, as the composer passes it (referenceRailShape).
  const singleShotRail = 'elements';

  it('names the Veo 3.1 variants that take the pictures a Quality run leaves out', () => {
    const draft = videoDraft(veo, { mode: 'veo3', references: pictures });

    // The run goes as frames without them, and nothing blocks it: they wait under "Not sent with this run".
    expect(catalogRunInputSlots(draft, veo).imageReferences).toBeUndefined();
    expect(validateCatalogCreationDraft(draft, veo, ready).errors).toEqual([]);
    expect(catalogStandbyReferencesReason(draft, veo, singleShotRail)).toBe('Veo 3.1 takes reference pictures on Lite or Fast.');
    // Beside a frame the run sends, too.
    expect(catalogStandbyReferencesReason({ ...draft, startFrame: upload('start.png', 'image') }, veo, singleShotRail))
      .toBe('Veo 3.1 takes reference pictures on Lite or Fast.');
  });

  it.each(['veo3_lite', 'veo3_fast'])('says nothing on %s, which sends the pictures', (mode) => {
    const draft = videoDraft(veo, { mode, references: pictures });

    expect(catalogRunInputSlots(draft, veo).imageReferences?.map((asset) => asset.url)).toEqual(pictures.map((picture) => picture.url));
    expect(catalogStandbyReferencesReason(draft, veo, singleShotRail)).toBeNull();
  });

  it('leaves pictures past the slot’s max to the validator’s line', () => {
    const draft = videoDraft(veo, { mode: 'veo3_fast', references: ['a', 'b', 'c', 'd'].map((name) => upload(`${name}.png`, 'image')) });

    expect(validateCatalogCreationDraft(draft, veo, ready).errors).toEqual(['Reference images supports up to 3 inputs.']);
    expect(catalogStandbyReferencesReason(draft, veo, singleShotRail)).toBeNull();
  });

  it('says nothing on Quality while the draft holds no picture', () => {
    expect(catalogStandbyReferencesReason(videoDraft(veo, { mode: 'veo3', startFrame: upload('start.png', 'image') }), veo, singleShotRail)).toBeNull();
  });

  it('keeps the silence of a model with no slot for them on any setting', () => {
    // Kling 3.0 takes clips beside its frames and no picture, on either quality mode.
    const onKling = videoDraft(kling30, { references: pictures });
    expect(catalogRunInputSlots(onKling, kling30).imageReferences).toBeUndefined();
    expect(catalogStandbyReferencesReason(onKling, kling30, singleShotRail)).toBeNull();
    // A descriptor without input modes has no slots to read.
    const withoutModes: GenerationModelDescriptor = { ...veo, inputModes: undefined };
    expect(catalogStandbyReferencesReason(videoDraft(withoutModes, { mode: 'veo3', references: pictures }), withoutModes, singleShotRail)).toBeNull();
  });

  // Kling O3's pictures open on its input mode alone, which follows what is attached and is no choice the
  // settings sheet shows: a multi-shot run, which sends no picture, must not be told "on References".
  it('names no option the settings sheet keeps off it', () => {
    const story = videoDraft(klingO3, {
      isMultiShot: true,
      multiPrompts: [{ id: 'shot-1', prompt: 'A door opens.', duration: 5 }],
      references: pictures,
    });
    const storyRail = catalogVideoRunReferenceMode(story, klingO3);

    expect(storyRail).toBe('frames');
    expect(catalogRunInputSlots(story, klingO3).imageReferences).toBeUndefined();
    expect(videoSettingsHiddenControlKeys(story)).toEqual(['isMultiShot', 'referenceMode', 'duration']);
    expect(catalogStandbyReferencesReason(story, klingO3, storyRail)).toBeNull();
  });

  it('names every option that opens the slot, in the control’s order and with its labels, for each kind', () => {
    const tiered = remoteVideoModel('tiered-video', {
      displayName: 'Tiered Video',
      controls: [
        {
          key: 'tier',
          label: 'Tier',
          type: 'choice',
          presentation: 'chips',
          defaultValue: 'basic',
          options: [{ value: 'basic', label: 'Basic' }, { value: 'plus', label: 'Plus' }, { value: 'pro', label: 'Pro' }, { value: 'max', label: 'Max' }],
        },
        choice('referenceMode', 'Input mode', ['frames', 'elements']),
      ],
      inputs: { ...noLegacyInputs, videoReferences: { max: 2 }, audioReferences: { max: 1 }, startFrame: true, endFrame: true },
      inputModes: [
        framesMode(),
        {
          ...referencesMode([
            { key: 'videoReferences', kind: 'video', role: 'reference', label: 'Reference videos', min: 0, max: 2 },
            { key: 'audioReferences', kind: 'audio', role: 'reference', label: 'Reference audio', min: 0, max: 1 },
          ]),
          // Listed out of the control's order: the line follows the control, as the sheet shows it.
          conditions: [byReferenceMode('elements'), { source: 'setting', key: 'tier', operator: 'in', value: ['max', 'plus', 'pro'] }],
        },
      ],
      inputConstraints: [],
    });
    const draft = videoDraft(tiered, {
      referenceVideos: [upload('spin.mp4', 'video', { durationSeconds: 4 })],
      referenceAudios: [upload('hum.mp3', 'audio', { durationSeconds: 4 })],
    });

    expect(catalogStandbyReferencesReason(draft, tiered, singleShotRail))
      .toBe('Tiered Video takes reference clips on Plus, Pro or Max. Tiered Video takes reference tracks on Plus, Pro or Max.');
  });
});

describe('a multi-shot run is priced and checked by its shots', () => {
  const shots = (durations: number[], prompt = (index: number) => `Beat ${index + 1}.`): VideoShotDraft[] => (
    durations.map((duration, index) => ({ id: `shot-${index + 1}`, prompt: prompt(index), duration }))
  );

  it('carries the shots’ total as the duration of the quote and the run, whatever the hidden stepper says', () => {
    const draft = videoDraft(kling30, { isMultiShot: true, duration: 5, multiPrompts: shots([5, 4.6]) });

    expect(multiShotTotalDuration(draft.multiPrompts)).toBe(10);
    expect(draft.duration).toBe(5);
    expect(getCatalogDraftSettings(draft, kling30).duration).toBe(10);
    expect(buildCatalogQuoteRequest(draft, kling30, 'revision-1').settings.duration).toBe(10);
    const request = buildUnifiedCatalogGenerationRequest(draft, kling30, 'revision-1');
    expect(request.settings).toEqual(buildCatalogQuoteRequest(draft, kling30, 'revision-1').settings);
    expect(request.settings.duration).toBe(10);
    expect(request.shots).toEqual([{ prompt: 'Beat 1.', duration: 5 }, { prompt: 'Beat 2.', duration: 5 }]);
    expect(buildCatalogGenerationPayload(draft, kling30, 'revision-1')).toMatchObject({ isMultiShot: true, duration: 10 });
    // Off multi-shot, the stepper's own duration is the run's again.
    expect(getCatalogDraftSettings({ ...draft, isMultiShot: false }, kling30).duration).toBe(5);
  });

  it('holds a run to the shots the provider takes and to the model’s longest duration', () => {
    expect(catalogMultiShotLimits(kling30)).toEqual({ maxShots: 5, maxTotalSeconds: 15 });
    expect(catalogMultiShotLimits(klingO3)).toEqual({ maxShots: 6, maxTotalSeconds: 15 });
    expect(catalogMultiShotLimits(seedance2)).toEqual({ maxShots: null, maxTotalSeconds: null });

    const run = (model: GenerationModelDescriptor, multiPrompts: VideoShotDraft[]) => (
      validateCatalogCreationDraft(videoDraft(model, { isMultiShot: true, multiPrompts }), model, ready).errors
    );
    expect(run(kling30, shots([2, 2, 2, 2, 2]))).toEqual([]);
    expect(run(kling30, shots([2, 2, 2, 2, 2, 2]))).toEqual(['Kling 3.0 Cinematic multi-shot supports at most 5 shots.']);
    expect(run(klingO3, shots([2, 2, 2, 2, 2, 2]))).toEqual([]);
    expect(run(klingO3, shots([2, 2, 2, 2, 2, 2, 2]))).toEqual(['Kling O3 multi-shot supports at most 6 shots.']);
    expect(run(kling30, shots([8, 8]))).toEqual(['Kling 3.0 Cinematic multi-shot runs can be at most 15 seconds in total.']);
  });

  it('sends no reference picture with the shots, and keeps the pictures for a single shot', () => {
    const pictures = [upload('hero.png', 'image'), upload('prop.png', 'image')];
    const start = upload('start.png', 'image');
    const singleShot = videoDraft(klingO3, { prompt: '@hero walks in.', references: pictures, startFrame: start });
    expect(singleShot.referenceMode).toBe('elements');

    const story = applyCatalogModelDefaults({ ...singleShot, isMultiShot: true, multiPrompts: shots([5, 5]) }, klingO3) as VideoCreationDraft;
    expect(story.references).toEqual(pictures);
    expect(story.referenceMode).toBe('frames');
    expect(videoDraftReferenceMode(story)).toBe('frames');
    expect(buildUnifiedCatalogGenerationRequest(story, klingO3, 'revision-1').inputs)
      .toEqual([expect.objectContaining({ slot: 'startFrame', url: start.url })]);
    expect(buildCatalogQuoteRequest(story, klingO3, 'revision-1').inputCounts).toMatchObject({ images: 1, videos: 0 });
  });

  it('refuses a shot that names something the run does not send, on the models whose shots the server reads', () => {
    const pictures = [upload('hero.png', 'image')];
    const named = (prompts: string[]) => shots([5, 5].slice(0, prompts.length), (index) => prompts[index]);

    const onO3 = videoDraft(klingO3, { isMultiShot: true, references: pictures, multiPrompts: named(['Open on @hero.', '@ghost turns, then @hero.']) });
    expect(validateCatalogCreationDraft(onO3, klingO3, ready).errors).toEqual(['Unknown element mentions: @hero, @ghost']);

    const hero = createSubjectDraft([upload('hero-1.png', 'image'), upload('hero-2.png', 'image')], 'Hero', []);
    const withSubject = videoDraft(klingO3, { isMultiShot: true, subjects: [hero], multiPrompts: named(['Open on @hero.', '@ghost turns.']) });
    expect(withSubject.referenceMode).toBe('subjects');
    expect(validateCatalogCreationDraft(withSubject, klingO3, ready).errors).toEqual(['Unknown element mention: @ghost']);

    const spin = { ...upload('spin.mp4', 'video', { durationSeconds: 4 }), handle: '@spin' };
    const onKling = videoDraft(kling30, { isMultiShot: true, referenceVideos: [spin], multiPrompts: named(['@spin turns.', 'Then @nope.']) });
    expect(validateCatalogCreationDraft(onKling, kling30, ready).errors).toEqual(['Unknown element mention: @nope']);

    // Another model's shots go as written, and so are not read.
    const otherMultiShot = remoteVideoModel('other-multi-shot', {
      ...kling30,
      id: 'other-multi-shot',
      displayName: 'Other multi-shot',
    });
    const elsewhere = videoDraft(otherMultiShot, { isMultiShot: true, multiPrompts: named(['@ghost turns.']) });
    expect(validateCatalogCreationDraft(elsewhere, otherMultiShot, ready).errors).toEqual([]);
  });
});

describe('prepared Seedance assets in a run on /api/generations', () => {
  const asset = (assetId: string, assetType: SeedanceAssetMetadata['assetType'], status: SeedanceAssetMetadata['status']): SeedanceAssetMetadata => ({
    assetId, assetType, status, sourceUrl: null, error: null, lastCheckedAt: '2026-10-13T00:00:00.000Z',
  });

  it('sends a prepared asset’s id beside the link the server measures, and the link alone for anything else', () => {
    const hero = { ...upload('hero.png', 'image'), seedanceAsset: asset('asset-hero', 'Image', 'active') };
    const prop = { ...upload('prop.png', 'image'), seedanceAsset: asset('asset-prop', 'Image', 'failed') };
    const motion = { ...upload('motion.mp4', 'video', { durationSeconds: 5 }), seedanceAsset: asset('asset-motion', 'Video', 'active') };
    const voice = { ...upload('voice.mp3', 'audio'), seedanceAsset: asset('asset-voice', 'Audio', 'processing') };
    const draft = videoDraft(seedance2, {
      prompt: 'The product from @hero spins beside @prop.',
      references: [hero, prop],
      referenceVideos: [motion],
      referenceAudios: [voice],
    });

    const { inputs } = buildUnifiedCatalogGenerationRequest(draft, seedance2, 'revision-1');
    expect(inputs).toEqual([
      expect.objectContaining({ slot: 'imageReferences', url: hero.url, assetId: 'asset-hero' }),
      expect.objectContaining({ slot: 'imageReferences', url: prop.url }),
      expect.objectContaining({ slot: 'videoReferences', url: motion.url, assetId: 'asset-motion', durationSeconds: 5 }),
      expect.objectContaining({ slot: 'audioReferences', url: voice.url }),
    ]);
    // An id the provider has not finished, or has refused, would fail there after the
    // credit hold: such a reference goes as its file.
    expect(inputs[1]).not.toHaveProperty('assetId');
    expect(inputs[3]).not.toHaveProperty('assetId');

    // Frames travel as links, as they always have.
    const framesRun = videoDraft(seedance2, { startFrame: { ...upload('start.png', 'image'), seedanceAsset: asset('asset-start', 'Image', 'active') } });
    expect(buildUnifiedCatalogGenerationRequest(framesRun, seedance2, 'revision-1').inputs)
      .toEqual([expect.not.objectContaining({ assetId: expect.anything() })]);

    // Only the Seedance 2 family takes a prepared asset.
    const other = remoteVideoModel('other-video', { ...seedance2, id: 'other-video', displayName: 'Other video' });
    const elsewhere = videoDraft(other, { prompt: 'The product from @hero spins.', references: [hero], referenceVideos: [motion] });
    expect(buildUnifiedCatalogGenerationRequest(elsewhere, other, 'revision-1').inputs.some((input) => 'assetId' in input)).toBe(false);
  });
});

describe('a slot whose mode opens on what the draft holds', () => {
  // The quote opens a run's slots with the draft's held input counts. The run looked its slots up
  // without them, so an input in a mode that opens on a count was priced and then left out.
  const voiceGated = remoteVideoModel('voice-gated-video', {
    inputModes: [
      framesMode([startFrameSlot]),
      {
        key: 'voice',
        label: 'Voice track',
        default: false,
        conditions: [{ source: 'inputCount', key: 'voiceTrack', operator: 'greaterThan', value: 0 }],
        slots: [{ key: 'voiceTrack', kind: 'audio', role: 'reference', label: 'Voice track', min: 0, max: 1 }],
      },
    ],
    inputConstraints: [],
  });

  it('sends the input its quote counted, and the creator shows it as going with the run', () => {
    const track = upload('voice.mp3', 'audio', { durationSeconds: 5 });
    const draft = videoDraft(voiceGated, { referenceAudios: [track] });
    const run = buildUnifiedCatalogGenerationRequest(draft, voiceGated, 'revision-1');

    expect(buildCatalogQuoteRequest(draft, voiceGated, 'revision-1').inputMetadata?.slots?.voiceTrack).toEqual({ count: 1, durationsSeconds: [5] });
    expect(run.inputs).toEqual([
      expect.objectContaining({ slot: 'voiceTrack', kind: 'audio', url: track.url, durationSeconds: 5 }),
    ]);
    // What the standby rail counts as sent is what the run sends.
    expect(Object.values(catalogRunInputSlots(draft, voiceGated)).flat().map((asset) => asset.url))
      .toEqual(run.inputs.map((input) => input.url));
  });
});

describe('a choice duration the server hands back as a number', () => {
  // The quote answers a choice duration as a number (the descriptor's normalizedValueType). A run
  // read back from that answer went out at the default '4' for a chosen 8 s Seedance 1.5 Pro run
  // (PR #480), so a run is built from the draft, as its quote request is, and never from the answer.
  const draft = videoDraft(seedance15ProModel, { prompt: 'A lighthouse in a storm', duration: 8, resolution: '720p' });

  it('runs the duration the quote priced', () => {
    const request = buildUnifiedCatalogGenerationRequest(draft, seedance15ProModel, 'revision-1');

    expect(request.settings).toEqual(buildCatalogQuoteRequest(draft, seedance15ProModel, 'revision-1').settings);
    expect(request.settings).toMatchObject({ duration: '8', resolution: '720p' });
  });

  it('keeps a number that names an option, and still refuses one that does not', () => {
    expect(normalizeCatalogSettings(seedance15ProModel, { duration: 12 }).duration).toBe('12');
    expect(normalizeCatalogSettings(seedance15ProModel, { duration: 5 }).duration).toBe('4');
    expect(normalizeCatalogSettings(seedance15ProModel, { resolution: 720 }).resolution).toBe('480p');
  });

  it('restores a remixed run at the duration it was made at', () => {
    // A run's workflow settings store its duration as a number too.
    const catalog = createRemixRestoreCatalog();
    const bundle: RemixSourceBundle = {
      generation: { id: 'source-generation', title: 'Lighthouse', prompt: 'A lighthouse in a storm', category: 'video', model: seedance15ProModel.id },
      result: null,
      inputs: { video: { referenceMode: 'frames', startFrame: null, endFrame: null, elements: [], referenceVideos: [], referenceAudios: [] } },
      workflowSettings: { model: seedance15ProModel.id, resolution: '720p', duration: 8, sound: false },
      restoreIssues: [],
    };
    const restored = hydrateCatalogCreationDraftFromRemixSource(
      createDefaultCreationDraft('video'),
      bundle,
      { ...catalog, models: [...catalog.models, seedance15ProModel] },
    );

    expect(restored.draft).toMatchObject({ model: 'seedance-1.5-pro', duration: 8, resolution: '720p' });
  });
});

describe('the inputs a quote counts are the inputs its run sends', () => {
  // The server quotes a run again from the inputs it sends, each counted by its kind
  // (buildUnifiedGenerationQuoteInput, src/lib/unified-generation-start-service.ts), and charges
  // or refuses that quote. A quote that counted inputs by the part they play priced a Wan 2.7
  // run at 80 credits that the server then refused. Wan 2.7 is production's descriptor of
  // revision pixverse-mobile-20261008, as /api/model-catalog/v1/details served it on 2026-10-18.
  const wan = parseModelCatalogDetail(liveCatalog.models.find((model) => model.id === 'wan-2.7'));

  it('counts the start frame that rides with five Wan 2.7 reference pictures, as the server counts the run', () => {
    const draft = videoDraft(wan, {
      references: [1, 2, 3, 4, 5].map((index) => upload(`look-${index}.png`, 'image')),
      startFrame: upload('doorstep.png', 'image'),
    });
    const run = buildUnifiedCatalogGenerationRequest(draft, wan, liveCatalog.revision);
    const quote = buildCatalogQuoteRequest(draft, wan, liveCatalog.revision);

    expect(run.settings.referenceMode).toBe('elements');
    expect(run.inputs.map((input) => input.slot)).toEqual([
      'imageReferences', 'imageReferences', 'imageReferences', 'imageReferences', 'imageReferences', 'startFrame',
    ]);
    // Six pictures go with the run, and the server's rules refuse six ("Wan 2.7 requires at
    // most 5 images"): asked about five, the quote said 80 credits and Generate stayed on.
    // Whether the start frame should count against those five is the catalog's rule to
    // decide; the quote answers as the start will.
    expect(quote.inputCounts).toEqual({ images: 6, videos: 0, audios: 0, preparedAudios: 0, characters: 0 });
    expect(quote.inputMetadata).toEqual({
      slots: { imageReferences: { count: 5 }, startFrame: { count: 1 } },
      referenceVideoDurationsSeconds: [],
    });
  });

  it('prices a clip of no finite length as the run body carries it, with no length', () => {
    // JSON has no NaN: the run's body carries such a length as null, which the server reads
    // as none. A quote that kept it sent [null], and the server refused the quote for it.
    const clip = { ...upload('turn.mp4', 'video'), durationSeconds: Number.NaN };
    const draft = videoDraft(kling30, { startFrame: upload('doorstep.png', 'image'), referenceVideos: [clip] });
    const quote = buildCatalogQuoteRequest(draft, kling30, 'revision-1');

    expect(JSON.parse(JSON.stringify(buildUnifiedCatalogGenerationRequest(draft, kling30, 'revision-1').inputs[1])))
      .toMatchObject({ slot: 'videoElements', durationSeconds: null });
    expect(quote.inputMetadata).toEqual({
      slots: { startFrame: { count: 1 }, videoElements: { count: 1 } },
      referenceVideoDurationsSeconds: [],
    });
  });
});

describe('the start a run is sent as', () => {
  // The creator shows the price of its ready quote, asked with the run's own quote input. The
  // run carries that price to the server, which refuses a start it prices above it
  // (cost_changed) before anything is held: drift between the quote and the start is a refusal,
  // never a charge the creator was not shown.
  const draft = videoDraft(kling30, { startFrame: upload('doorstep.png', 'image') });
  const run = buildUnifiedCatalogGenerationRequest(draft, kling30, 'revision-1');
  const quoteKey = JSON.stringify(buildCatalogQuoteRequest(draft, kling30, 'revision-1'));

  it('carries the price of the ready quote of that very run', () => {
    expect(catalogStartRequest(run, { key: quoteKey, status: 'ready', cost: 70 }))
      .toEqual({ ...run, expectedCostCredits: 70 });
  });

  it('carries no price without a ready quote of that run in whole credits', () => {
    const otherRun = JSON.stringify(buildCatalogQuoteRequest(videoDraft(kling30), kling30, 'revision-1'));
    for (const quote of [
      { key: quoteKey, status: 'pending' as const, cost: null },
      { key: quoteKey, status: 'error' as const, cost: null },
      { key: null, status: 'idle' as const, cost: null },
      { key: otherRun, status: 'ready' as const, cost: 70 },
      { key: quoteKey, status: 'ready' as const, cost: 70.5 },
    ]) {
      expect(catalogStartRequest(run, quote)).toBe(run);
    }
  });

  it('carries no price for a descriptor without input modes, whose quote is not the run’s own', () => {
    // Schema-1 descriptors only: their quote counts the draft's inputs, which may not be the
    // run's, so a price from it could refuse a run the server would price right.
    const legacyDraft: ImageCreationDraft = { ...createDefaultCreationDraft('image'), model: remoteImageModel.id, prompt: 'A bottle on linen' };
    const legacyRun = buildUnifiedCatalogGenerationRequest(legacyDraft, remoteImageModel, 'revision-1');
    const legacyQuoteKey = JSON.stringify(buildCatalogQuoteRequest(legacyDraft, remoteImageModel, 'revision-1'));

    expect(catalogStartRequest(legacyRun, { key: legacyQuoteKey, status: 'ready', cost: 8 })).toBe(legacyRun);
  });
});

// A fresh-context review of PR #481 found the creator screen reading a draft its own way where the run
// already says what it sends (catalogRunInputSlots): a copy of the held counts, and Enhance read off
// the attachments without the model (videoDraftReferenceMode). These are the run's own answers.
describe('what the creator reads off the run it would send', () => {
  const wan = parseModelCatalogDetail(liveCatalog.models.find((model) => model.id === 'wan-2.7'));
  const named = (media: MediaDraft, handle: string): MediaDraft => ({ ...media, handle });

  it('counts what a draft holds for each slot as the run counts it', () => {
    // The screen's copy counted a subject's pictures as the draft's references, and an end frame in a
    // multi-shot run, which no run sends.
    const hero = createSubjectDraft([upload('hero-front.png', 'image'), upload('hero-side.png', 'image')], 'Hero', []);
    const subjects = videoDraft(klingO3, { prompt: '@hero walks in', subjects: [hero], references: [upload('kept.png', 'image')] });
    expect(catalogDraftInputCounts(subjects, klingO3)).toEqual({ startFrame: 0, imageReferences: 1, subjectImages: 2 });

    // Set past the creator's own normalizing, which drops a multi-shot run's end frame.
    const story = { ...videoDraft(kling30, { isMultiShot: true, startFrame: upload('first.png', 'image') }), endFrame: upload('last.png', 'image') };
    expect(catalogDraftInputCounts(story, kling30)).toEqual({ startFrame: 1, endFrame: 0, videoElements: 0 });
  });

  describe('Enhance is told what the run sends', () => {
    const enhanced = (draft: VideoCreationDraft, model: GenerationModelDescriptor) => (
      buildPromptEnhancementRequest(draft, { videoRun: catalogRunEnhancementInputs(draft, model) }).context
    );

    it('a Kling 3.0 run: its start frame, and the named clip that goes beside it', () => {
      const draft = videoDraft(kling30, {
        prompt: 'Open on the door, then @turn',
        startFrame: upload('door.png', 'image'),
        referenceVideos: [named(upload('turn.mp4', 'video', { durationSeconds: 3 }), '@turn')],
      });

      expect(enhanced(draft, kling30)).toMatchObject({
        hasStartImage: true,
        hasEndImage: false,
        hasReferenceVideo: true,
        referenceImageCount: 0,
        elementReferences: [{ handle: '@turn', displayName: 'turn' }],
        frameImageUrls: ['https://cdn.example.com/door.png'],
      });
    });

    it('a Wan 2.7 references run: its picture and the start frame it takes beside it, and no end frame', () => {
      const draft = videoDraft(wan, {
        prompt: 'The product from @look turns on the doorstep',
        references: [upload('look.png', 'image')],
        startFrame: upload('doorstep.png', 'image'),
        endFrame: upload('porch.png', 'image'),
      });

      expect(enhanced(draft, wan)).toMatchObject({
        hasStartImage: true,
        hasEndImage: false,
        hasReferenceVideo: false,
        referenceImageCount: 1,
        elementReferences: [{ handle: '@look', displayName: 'look' }],
        frameImageUrls: ['https://cdn.example.com/doorstep.png'],
      });
    });

    it('a Seedance 1.5 Pro frames run: clips kept from another model are not sent, so not described', () => {
      const draft = videoDraft(seedance15ProModel, {
        prompt: 'A walk at dusk',
        startFrame: upload('street.png', 'image'),
        endFrame: upload('corner.png', 'image'),
        referenceVideos: [named(upload('stroll.mp4', 'video', { durationSeconds: 4 }), '@stroll')],
      });

      expect(enhanced(draft, seedance15ProModel)).toMatchObject({
        hasStartImage: true,
        hasEndImage: true,
        hasReferenceVideo: false,
        referenceImageCount: 0,
        elementReferences: [],
        frameImageUrls: ['https://cdn.example.com/street.png', 'https://cdn.example.com/corner.png'],
      });
    });

    it('a Kling O3 subjects run: each subject once, by its own name, and none of its pictures as a reference', () => {
      const hero = createSubjectDraft([upload('hero-front.png', 'image'), upload('hero-side.png', 'image')], 'Hero', []);
      const draft = videoDraft(klingO3, { prompt: '@hero walks in', subjects: [hero], startFrame: upload('hall.png', 'image') });

      expect(enhanced(draft, klingO3)).toMatchObject({
        hasStartImage: false,
        hasEndImage: false,
        hasReferenceVideo: false,
        referenceImageCount: 0,
        elementReferences: [{ handle: '@hero', displayName: 'Hero' }],
      });
      expect(enhanced(draft, klingO3)).not.toHaveProperty('frameImageUrls');
    });
  });
});

/**
 * Each model's own prompt limit (lib/model-catalog/provider-prompt-limits.ts, which the server's
 * starts read too): the run waits with the start's own words, which name the model and the limit,
 * and nothing shortens the prompt, across a model change included.
 */
describe('a prompt is held to its model’s own limit', () => {
  const imageDraftOn = (model: GenerationModelDescriptor, prompt: string, overrides: Partial<ImageCreationDraft> = {}) => (
    applyCatalogModelDefaults({ ...createDefaultCreationDraft('image'), model: model.id, prompt, ...overrides }, model) as ImageCreationDraft
  );
  const zImage = imageModelWithSlots('z-image', 'Z-Image', 0);

  it('waits past the limit in the start’s words, keeps the prompt whole, and reads the counter over', () => {
    const over = imageDraftOn(zImage, 'x'.repeat(1001));
    expect(over.prompt).toHaveLength(1001);
    expect(validateCatalogCreationDraft(over, zImage, ready)).toMatchObject({
      errors: ['Z-Image prompts support up to 1,000 characters.'],
      canGenerate: false,
    });
    expect(catalogPromptLimitError(over, zImage)).toBe('Z-Image prompts support up to 1,000 characters.');
    expect(catalogPromptMeters(over, zImage).prompt).toEqual({ length: 1001, limit: 1000, state: 'over', label: '1,001 / 1,000' });

    const atLimit = imageDraftOn(zImage, 'x'.repeat(1000));
    expect(validateCatalogCreationDraft(atLimit, zImage, ready)).toMatchObject({ errors: [], canGenerate: true });
    expect(catalogPromptMeters(atLimit, zImage).prompt).toMatchObject({ label: '1,000 / 1,000', state: 'near' });
  });

  it('keeps the prompt across a switch to a model with a lower limit, which marks it over until the switch back', () => {
    const roomy = imageModelWithSlots('nano-banana-2', 'Nano Banana 2.0', 4);
    const prompt = 'y'.repeat(4000);
    const onRoomy = imageDraftOn(roomy, prompt);
    expect(validateCatalogCreationDraft(onRoomy, roomy, ready).errors).toEqual([]);
    expect(catalogPromptMeters(onRoomy, roomy).prompt).toMatchObject({ label: '4,000 / 10,000', state: 'within' });

    const onZImage = applyCatalogModelDefaults(onRoomy, zImage) as ImageCreationDraft;
    expect(onZImage.prompt).toBe(prompt);
    expect(validateCatalogCreationDraft(onZImage, zImage, ready).errors).toEqual(['Z-Image prompts support up to 1,000 characters.']);
    expect(catalogPromptMeters(onZImage, zImage).prompt).toMatchObject({ label: '4,000 / 1,000', state: 'over' });

    const back = applyCatalogModelDefaults(onZImage, roomy) as ImageCreationDraft;
    expect(back.prompt).toBe(prompt);
    expect(validateCatalogCreationDraft(back, roomy, ready)).toMatchObject({ errors: [], canGenerate: true });
  });

  it('asks for the fewest characters a provider takes, and leaves an empty prompt to its own message', () => {
    const lite = imageModelWithSlots('seedream-5-lite', 'Seedream 5 Lite', 14);
    expect(validateCatalogCreationDraft(imageDraftOn(lite, 'cat'), lite, ready).errors).toEqual(['Seedream 5 Lite prompts need at least 4 characters.']);
    expect(validateCatalogCreationDraft(imageDraftOn(lite, 'cats'), lite, ready).errors).toEqual([]);
    expect(validateCatalogCreationDraft(imageDraftOn(lite, '   '), lite, ready).errors).toEqual(['Prompt is required.']);
    expect(catalogPromptMeters(imageDraftOn(lite, ''), lite).prompt.label).toBe('0 / 2,995');
  });

  it('lifts Grok Imagine’s text-only cap while the run sends a picture, as its edit endpoint takes more', () => {
    const grok = imageModelWithSlots('grok-imagine-image', 'Grok Imagine', 1);
    const textOnly = imageDraftOn(grok, 'g'.repeat(5001));
    expect(validateCatalogCreationDraft(textOnly, grok, ready).errors).toEqual(['Grok Imagine prompts support up to 5,000 characters.']);
    expect(catalogPromptMeters(textOnly, grok).prompt.limit).toBe(5000);

    const edit = imageDraftOn(grok, 'g'.repeat(5001), { references: [upload('hero.png', 'image')] });
    expect(validateCatalogCreationDraft(edit, grok, ready).errors).toEqual([]);
    expect(catalogPromptMeters(edit, grok).prompt.limit).toBe(10000);
  });

  it('holds each shot to its model’s shot limit, names the shot, and leaves the prompt kept behind a Kling 3.0 story alone', () => {
    const story = videoDraft(kling30, {
      prompt: 'x'.repeat(3000),
      isMultiShot: true,
      multiPrompts: [{ id: 's1', prompt: 'A door opens', duration: 5 }, { id: 's2', prompt: 'z'.repeat(501), duration: 5 }],
    });
    expect(validateCatalogCreationDraft(story, kling30, ready).errors).toEqual(['Shot 2: Kling 3.0 Cinematic shot prompts support up to 500 characters.']);
    expect(catalogPromptMeters(story, kling30).shots).toEqual({
      s1: { length: 12, limit: 500, state: 'within', label: '12 / 500' },
      s2: { length: 501, limit: 500, state: 'over', label: '501 / 500' },
    });
    // The 3,000-character prompt behind the shots is not sent to Kling 3.0 in a story.
    const fits = { ...story, multiPrompts: [story.multiPrompts[0], { ...story.multiPrompts[1], prompt: 'z'.repeat(500) }] };
    expect(validateCatalogCreationDraft(fits, kling30, ready).errors).toEqual([]);
    // Kling O3's shots take 512.
    const o3 = videoDraft(klingO3, { isMultiShot: true, multiPrompts: [{ id: 's1', prompt: 'o'.repeat(512), duration: 5 }] });
    expect(validateCatalogCreationDraft(o3, klingO3, ready).errors).toEqual([]);
    expect(validateCatalogCreationDraft({ ...o3, multiPrompts: [{ id: 's1', prompt: 'o'.repeat(513), duration: 5 }] }, klingO3, ready).errors)
      .toEqual(['Shot 1: Kling O3 shot prompts support up to 512 characters.']);
  });

  it('counts each mention of one of a Kling 3.0 run’s clips as the 37 characters Kling counts', () => {
    const spin = { ...upload('spin.mp4', 'video', { durationSeconds: 4 }), handle: '@spin' };
    // 2,468 characters as written; 2,500 as Kling counts its one mention of @spin.
    const typed = `${'a'.repeat(2500 - 37 - 1)} @spin`;
    const draft = videoDraft(kling30, { prompt: typed, startFrame: upload('start.png', 'image'), referenceVideos: [spin] });
    expect(catalogPromptMeters(draft, kling30).prompt).toMatchObject({ length: 2500, state: 'near' });
    expect(validateCatalogCreationDraft(draft, kling30, ready).errors).toEqual([]);

    expect(validateCatalogCreationDraft({ ...draft, prompt: `a${typed}` }, kling30, ready).errors)
      .toEqual(['Kling 3.0 Cinematic prompts support up to 2,500 characters, counting each video element mention as 37.']);
  });

  it('counts a motion prompt against Kie’s 2,500, and a draft whose model is not in yet by its own id', () => {
    const motionModel = createTestGenerationModelCatalog().models.find((model) => model.id === 'kling-3.0')!;
    const motion = { ...createDefaultCreationDraft('motion'), prompt: 'Calm, then a spin.' };
    expect(catalogPromptMeters(motion, motionModel).prompt).toMatchObject({ limit: 2500, label: '18 / 2,500' });
    expect(catalogPromptMeters({ ...createDefaultCreationDraft('image'), model: 'z-image', prompt: 'x' }, null).prompt.limit).toBe(1000);
  });
});
