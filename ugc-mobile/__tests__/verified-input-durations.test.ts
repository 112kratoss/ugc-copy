import { describe, expect, it } from 'vitest';

import {
  applyCatalogModelDefaults,
  applyVerifiedInputDurations,
  buildCatalogQuoteRequest,
  buildUnifiedCatalogGenerationRequest,
  readVerifiedInputDurations,
} from '../lib/generation-model-draft';
import {
  createDefaultCreationDraft,
  createMediaDraftFromUpload,
} from '../lib/media-creation-view-model';
import { remoteVideoModel } from './generation-model-catalog-v2-fixtures';

function uploadedVideo(durationSeconds: number) {
  return createMediaDraftFromUpload({
    signedUrl: 'https://cdn.example.com/reference.mp4',
    storagePath: 'uploads/user-1/reference.mp4',
    mimeType: 'video/mp4',
    fileName: 'reference.mp4',
    kind: 'video',
    durationSeconds,
  }, { displayName: 'Reference motion' });
}

describe('verified reference lengths', () => {
  it('reads only well-formed measured lengths from a refusal', () => {
    expect(readVerifiedInputDurations({
      code: 'REFERENCE_DURATION_CHANGED',
      inputs: [
        { index: 0, slot: 'videoReferences', durationSeconds: 10.2 },
        { index: -1, slot: 'videoReferences', durationSeconds: 3 },
        { index: 1, slot: 'videoReferences', durationSeconds: 0 },
        { index: 2, durationSeconds: 4 },
        'not an input',
      ],
    })).toEqual([{ index: 0, slot: 'videoReferences', durationSeconds: 10.2 }]);
    expect(readVerifiedInputDurations(null)).toEqual([]);
    expect(readVerifiedInputDurations({ inputs: 'nope' })).toEqual([]);
  });

  it('takes a measured length into the draft, so the next quote is priced from it', () => {
    const model = remoteVideoModel();
    const draft = applyCatalogModelDefaults({
      ...createDefaultCreationDraft('video'),
      model: model.id,
      prompt: 'Follow the reference motion.',
      referenceMode: 'elements',
      resolution: '1080p',
      duration: 7,
      referenceVideos: [uploadedVideo(0)],
      catalogSettings: { referenceMode: 'elements', resolution: '1080p', duration: 7 },
    }, model, 'catalog-v2-revision');
    const request = buildUnifiedCatalogGenerationRequest(draft, model, 'catalog-v2-revision');
    const index = request.inputs.findIndex((input) => input.slot === 'videoReferences');
    expect(index).toBeGreaterThanOrEqual(0);

    const measured = applyVerifiedInputDurations(draft, request, [
      { index, slot: 'videoReferences', durationSeconds: 12.5 },
    ]);

    expect(buildCatalogQuoteRequest(measured, model, 'catalog-v2-revision')).toMatchObject({
      inputMetadata: {
        slots: { videoReferences: { durationsSeconds: [12.5] } },
        referenceVideoDurationsSeconds: [12.5],
      },
    });
    // Nothing measured, nothing changed.
    expect(applyVerifiedInputDurations(draft, request, [])).toBe(draft);
  });

  it('moves a motion run’s duration to its measured reference performance', () => {
    const video = uploadedVideo(1);
    const draft = {
      ...createDefaultCreationDraft('motion'),
      referenceVideo: video,
      duration: 1,
    };

    const measured = applyVerifiedInputDurations(draft, {
      inputs: [
        { slot: 'characterImage', kind: 'image', url: 'https://cdn.example.com/character.png' },
        { slot: 'referenceVideo', kind: 'video', url: video.url, storagePath: video.storagePath },
      ],
    }, [{ index: 1, slot: 'referenceVideo', durationSeconds: 29.4 }]);

    expect(measured).toMatchObject({
      duration: 30,
      referenceVideo: { durationSeconds: 29.4 },
    });
  });
});
