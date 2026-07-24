import { describe, expect, it } from 'vitest';

import {
  applyCatalogModelInitialDefaults,
  applyCatalogModelDefaults,
  buildCatalogQuoteRequest,
  buildUnifiedCatalogGenerationRequest,
  hydrateCatalogCreationDraftFromRemixSource,
  reconcileCreationDraftWithCatalog,
  validateCatalogCreationDraft,
} from '../lib/generation-model-draft';
import {
  createDefaultCreationDraft,
  createMediaDraftFromUpload,
} from '../lib/media-creation-view-model';
import type { RemixSourceBundle } from '../lib/types';
import { catalogV2, remoteVideoModel } from './generation-model-catalog-v2-fixtures';

describe('catalog-v2 mobile drafts', () => {
  it('uses published defaults for an untouched transition draft', () => {
    const model = remoteVideoModel();
    const draft = applyCatalogModelInitialDefaults(
      createDefaultCreationDraft('video'),
      model,
      'catalog-v2-revision',
    );

    expect(draft).toMatchObject({
      model: 'remote-video-v2',
      referenceMode: 'elements',
      resolution: '720p',
      duration: 7,
      catalogRevision: 'catalog-v2-revision',
      catalogSettings: {
        referenceMode: 'elements',
        resolution: '720p',
        duration: 7,
      },
    });
  });

  it('keeps remote ids and settings generic and sends reference durations to quote/generation', () => {
    const model = remoteVideoModel();
    const referenceVideo = createMediaDraftFromUpload({
      signedUrl: 'https://cdn.example.com/reference.mp4',
      storagePath: 'uploads/reference.mp4',
      mimeType: 'video/mp4',
      fileName: 'reference.mp4',
      kind: 'video',
      durationSeconds: 8.5,
    }, { displayName: 'Reference motion' });
    const draft = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      model: model.id,
      prompt: 'Follow the reference motion.',
      referenceMode: 'elements',
      resolution: '1080p',
      duration: 7,
      referenceVideos: [referenceVideo],
      catalogSettings: {
        referenceMode: 'elements',
        resolution: '1080p',
        duration: 7,
      },
    }, model, 'catalog-v2-revision');
    if (draft.tool !== 'video') throw new Error('Expected a video draft.');

    expect(draft.model).toBe('remote-video-v2');
    expect(draft.catalogSettings).toEqual({
      referenceMode: 'elements',
      resolution: '1080p',
      duration: 7,
    });
    expect(buildCatalogQuoteRequest(draft, model, 'catalog-v2-revision')).toMatchObject({
      modelId: 'remote-video-v2',
      catalogRevision: 'catalog-v2-revision',
      inputCounts: { videos: 1 },
      inputMetadata: {
        slots: {
          videoReferences: { count: 1, durationsSeconds: [8.5] },
        },
        referenceVideoDurationsSeconds: [8.5],
      },
    });
    expect(buildUnifiedCatalogGenerationRequest(draft, model, 'catalog-v2-revision')).toMatchObject({
      kind: 'video',
      modelId: 'remote-video-v2',
      catalogRevision: 'catalog-v2-revision',
      settings: { resolution: '1080p' },
      inputs: [{
        slot: 'videoReferences',
        kind: 'video',
        durationSeconds: 8.5,
      }],
    });
  });

  it('validates required duration metadata and combined-duration constraints', () => {
    const model = remoteVideoModel();
    const media = (durationSeconds: number | null, id: string) => createMediaDraftFromUpload({
      signedUrl: `https://cdn.example.com/${id}.mp4`,
      storagePath: `uploads/${id}.mp4`,
      mimeType: 'video/mp4',
      fileName: `${id}.mp4`,
      kind: 'video',
      durationSeconds,
    }, { displayName: id });
    const missingDuration = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      model: model.id,
      prompt: 'Animate.',
      referenceMode: 'elements',
      referenceVideos: [media(null, 'missing')],
    }, model);
    expect(validateCatalogCreationDraft(missingDuration, model).errors).toContain(
      'Reference videos requires duration metadata.',
    );

    const tooLong = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      model: model.id,
      prompt: 'Animate.',
      referenceMode: 'elements',
      referenceVideos: [media(15, 'one'), media(15, 'two'), media(1, 'three')],
    }, model);
    expect(validateCatalogCreationDraft(tooLong, model).errors).toContain(
      'Reference videos may total at most 30 seconds.',
    );
  });

  it('activates conditional slots from the draft mode even when mode is not a visible control', () => {
    const baseModel = remoteVideoModel();
    const model = remoteVideoModel(undefined, {
      controls: baseModel.controls.filter((control) => control.key !== 'referenceMode'),
    });
    const reference = createMediaDraftFromUpload({
      signedUrl: 'https://cdn.example.com/no-duration.mp4',
      storagePath: 'uploads/no-duration.mp4',
      mimeType: 'video/mp4',
      fileName: 'no-duration.mp4',
      kind: 'video',
      durationSeconds: null,
    }, { displayName: 'Reference without duration' });
    const draft = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      model: model.id,
      prompt: 'Use the reference.',
      referenceMode: 'elements',
      referenceVideos: [reference],
    }, model);

    expect(validateCatalogCreationDraft(draft, model).errors).toContain(
      'Reference videos requires duration metadata.',
    );
  });

  it('preserves compatible draft content and moves retired ids to the published default', () => {
    const retired = remoteVideoModel('retired-video-v2');
    const normalizedOriginal = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      model: retired.id,
      prompt: 'Preserve this prompt.',
      resolution: '1080p',
      catalogSettings: {
        referenceMode: 'elements',
        resolution: '1080p',
        duration: 7,
      },
    }, retired, 'old-revision');
    const original = {
      ...normalizedOriginal,
      catalogSettings: {
        ...normalizedOriginal.catalogSettings,
        removedSetting: true,
      },
    };
    const nextCatalog = catalogV2([remoteVideoModel('fallback-video-v2')]);
    const result = reconcileCreationDraftWithCatalog(original, nextCatalog);

    expect(result).toMatchObject({
      switchedModel: true,
      previousModelId: 'retired-video-v2',
      discardedSettingKeys: ['removedSetting'],
      draft: {
        model: 'fallback-video-v2',
        prompt: 'Preserve this prompt.',
        catalogRevision: 'catalog-v2-revision',
        catalogSettings: {
          resolution: '1080p',
        },
      },
    });
    expect(result.warning).toContain('is no longer available');
  });

  it('warns when a refresh removes settings and preserves inactive slot drafts', () => {
    const originalModel = remoteVideoModel();
    const original = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      model: originalModel.id,
      prompt: 'Keep my compatible draft.',
      referenceMode: 'elements',
      catalogSettings: {
        referenceMode: 'elements',
        resolution: '1080p',
        duration: 7,
      },
      catalogInputSlots: {
        videoReferences: [{
          id: 'video-reference',
          kind: 'video',
          url: 'https://cdn.example.com/reference.mp4',
          durationSeconds: 5,
        }],
        startFrame: [{
          id: 'start-frame',
          kind: 'image',
          url: 'https://cdn.example.com/start.jpg',
        }],
      },
    }, originalModel, 'old-revision');
    const refreshedModel = remoteVideoModel(undefined, {
      controls: originalModel.controls.filter((control) => control.key !== 'resolution'),
    });
    const result = reconcileCreationDraftWithCatalog(
      original,
      catalogV2([refreshedModel]),
    );

    expect(result.switchedModel).toBe(false);
    expect(result.discardedSettingKeys).toContain('resolution');
    expect(result.warning).toContain('Some saved settings are no longer supported');
    expect(result.draft.catalogInputSlots).toMatchObject({
      videoReferences: [{ id: 'video-reference' }],
      startFrame: [{ id: 'start-frame' }],
    });
  });

  it('restores a remix that uses a remote id and reconciles a retired remix id', () => {
    const catalog = catalogV2();
    const bundle: RemixSourceBundle = {
      generation: {
        id: 'source-generation',
        title: 'Remote source',
        prompt: 'Restore this remote workflow.',
        category: 'video',
        model: 'remote-video-v2',
      },
      result: null,
      inputs: {
        video: {
          referenceMode: 'elements',
          startFrame: null,
          endFrame: null,
          elements: [],
          referenceVideos: [],
          referenceAudios: [],
        },
      },
      workflowSettings: {
        model: 'remote-video-v2',
        settings: {
          referenceMode: 'elements',
          resolution: '4k',
          duration: 7,
        },
      },
      restoreIssues: [],
    };
    const restored = hydrateCatalogCreationDraftFromRemixSource(
      createDefaultCreationDraft('video'),
      bundle,
      catalog,
    );
    expect(restored).toMatchObject({
      switchedModel: false,
      draft: {
        model: 'remote-video-v2',
        prompt: 'Restore this remote workflow.',
        catalogSettings: { resolution: '4k' },
      },
    });

    const retired = hydrateCatalogCreationDraftFromRemixSource(
      createDefaultCreationDraft('video'),
      {
        ...bundle,
        generation: { ...bundle.generation, model: 'retired-remote-model' },
        workflowSettings: { ...bundle.workflowSettings, model: 'retired-remote-model' },
      },
      catalog,
    );
    expect(retired.switchedModel).toBe(true);
    expect(retired.draft.model).toBe('fallback-video-v2');
    expect(retired.warning).toContain('is no longer available');
  });
});
