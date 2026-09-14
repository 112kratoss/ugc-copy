import { describe, expect, it } from 'vitest';

import {
  hydrateCatalogCreationDraftFromRemixSource,
  validateCatalogCreationDraft,
} from '../lib/generation-model-draft';
import {
  createDefaultCreationDraft,
  REMIX_RESTORE_WARNING_MESSAGE,
  type VideoCreationDraft,
} from '../lib/media-creation-view-model';
import type { RemixResolvedImageElement, RemixSourceBundle } from '../lib/types';
import { catalogV2, remoteVideoModel } from './generation-model-catalog-v2-fixtures';

function namedReference(handle: string, index: number): RemixResolvedImageElement {
  const name = handle.slice(1);
  return {
    id: `imageReferences-${index}`,
    displayName: name,
    handle,
    storagePath: `generation_inputs/owner/source-generation/0${index}-reference_image.jpg`,
    sourceGenerationId: null,
    url: `https://cdn.example.com/${name}.jpg`,
  };
}

function namedReferenceRemix(elements: RemixResolvedImageElement[], prompt: string): RemixSourceBundle {
  return {
    generation: {
      id: 'source-generation',
      title: 'Referenced source',
      prompt,
      category: 'video',
      model: 'remote-video-v2',
    },
    result: null,
    inputs: {
      video: {
        referenceMode: 'elements',
        startFrame: null,
        endFrame: null,
        elements,
        referenceVideos: [],
        referenceAudios: [],
      },
    },
    workflowSettings: { model: 'remote-video-v2', referenceMode: 'elements', duration: 4 },
    restoreIssues: [],
  };
}

describe('catalog remix restore of reusable video references', () => {
  // The create screen passes a default video draft, whose model is kling-3.0-video. The
  // bundled registry gives that model no image references, so capping restored media
  // against it emptied every Seedance 2 remix before the catalog model was applied.
  it('keeps named references the catalog model accepts, whatever the draft model was', () => {
    const catalog = catalogV2();
    const model = catalog.models.find((entry) => entry.id === 'remote-video-v2')!;

    const restored = hydrateCatalogCreationDraftFromRemixSource(
      createDefaultCreationDraft('video'),
      namedReferenceRemix([namedReference('@girl', 1)], 'The girl from @girl is crying'),
      catalog,
    );

    expect(restored.warning).toBeNull();
    expect(restored.draft).toMatchObject({
      model: 'remote-video-v2',
      referenceMode: 'elements',
      duration: 4,
      references: [expect.objectContaining({ handle: '@girl', url: 'https://cdn.example.com/girl.jpg' })],
    });
    expect(validateCatalogCreationDraft(restored.draft, model).errors)
      .not.toContainEqual(expect.stringContaining('Unknown element mention'));
  });

  it('still caps restored references at the catalog model limit and says so', () => {
    const narrow = remoteVideoModel('remote-video-v2', {
      inputs: { ...remoteVideoModel().inputs, imageReferences: { max: 1, supportsNaming: true } },
    });
    const catalog = catalogV2([remoteVideoModel('fallback-video-v2'), narrow]);

    const restored = hydrateCatalogCreationDraftFromRemixSource(
      createDefaultCreationDraft('video'),
      namedReferenceRemix([namedReference('@ref1', 1), namedReference('@ref2', 2)], 'Blend @ref1 and @ref2'),
      catalog,
    );

    expect((restored.draft as VideoCreationDraft).references.map((reference) => reference.handle)).toEqual(['@ref1']);
    expect(restored.warning).toBe(REMIX_RESTORE_WARNING_MESSAGE);
  });
});
