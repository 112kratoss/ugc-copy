import { describe, expect, it } from 'vitest';

import subjectsContract from '../../contracts/model-catalog-subjects-mode-v1.json';
import type {
  CatalogControl,
  CatalogInputMode,
  CatalogInputSlot,
  GenerationModelDescriptor,
} from '../lib/generation-model-catalog';
import { normalizeCatalogSettings } from '../lib/generation-model-catalog';
import {
  applyCatalogModelDefaults,
  catalogDraftRunHandles,
  catalogMultiShotLimits,
  catalogRunInputSlots,
  catalogVideoRunReferenceMode,
  reconcileCreationDraftWithCatalog,
  buildCatalogGenerationPayload,
  buildCatalogQuoteRequest,
  buildUnifiedCatalogGenerationRequest,
  getCatalogCreationSectionSummary,
  getCatalogDraftSettings,
  hydrateCatalogCreationDraftFromRemixSource,
  multiShotTotalDuration,
  validateCatalogCreationDraft,
} from '../lib/generation-model-draft';
import {
  createDefaultCreationDraft,
  createMediaDraftFromUpload,
  createSubjectDraft,
  videoDraftReferenceMode,
  type ImageCreationDraft,
  type MediaDraft,
  type VideoCreationDraft,
  type VideoShotDraft,
} from '../lib/media-creation-view-model';
import type { SeedanceAssetMetadata } from '../lib/model-catalog/seedance-assets';
import type { RemixSourceBundle } from '../lib/types';
import { createRemixRestoreCatalog, createTestGenerationModelCatalog, remoteImageModel, seedance15ProModel } from './fixtures/generation-model-catalog';
import { remoteVideoModel } from './generation-model-catalog-v2-fixtures';

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

const kling30 = remoteVideoModel('kling-3.0-video', {
  displayName: 'Kling 3.0 Cinematic',
  controls: [
    choice('aspectRatio', 'Aspect ratio', ['16:9', '9:16', '1:1']),
    choice('mode', 'Quality mode', ['std', 'pro']),
    seconds(3, 15, 5),
    toggle('sound', 'Sound'),
    toggle('isMultiShot', 'Multi-shot'),
  ],
  capabilities: { multiShot: true, sound: true, fixedLens: false, googleSearch: false, outputFormat: false },
  inputs: { ...noLegacyInputs, videoReferences: { max: 3 }, startFrame: true, endFrame: true },
  inputModes: [
    framesMode(),
    {
      key: 'video-elements',
      label: 'Video elements',
      default: false,
      slots: [{ key: 'videoElements', kind: 'video', role: 'reference', label: 'Video elements', min: 0, max: 3, supportsNaming: true, durationMetadata: 'optional' }],
    },
  ],
  inputConstraints: [],
});

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
    expect(buildCatalogQuoteRequest(draft, kling30, 'revision-1')).toMatchObject({
      inputCounts: { images: 1, videos: 0 },
      inputMetadata: { slots: { startFrame: { count: 1 }, videoElements: { count: 1, durationsSeconds: [4] } } },
    });
    expect(validateCatalogCreationDraft(draft, kling30, ready)).toMatchObject({ errors: [], canGenerate: true });
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
