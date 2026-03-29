import { describe, expect, it } from 'vitest';

import {
  createRemixElementSeeds,
  createRemixResultReferenceElement,
  createRestoredRemixAssetState,
  getRemixRestoreWarning,
  getRemixResultReferenceLabel,
} from '@/lib/remix-source-client';
import type { RemixSourceBundle } from '@/lib/remix-source';

describe('remix source client helpers', () => {
  it('builds remix element seeds from resolved source elements', () => {
    const seeds = createRemixElementSeeds([
      {
        id: 'el-1',
        displayName: 'Bottle',
        handle: '@bottle',
        storagePath: 'uploads/user-1/bottle.png',
        sourceGenerationId: null,
        url: 'https://signed.example.com/bottle.png',
      },
      {
        id: 'el-2',
        displayName: 'Hidden',
        handle: '@hidden',
        storagePath: null,
        sourceGenerationId: 'source-2',
        url: null,
      },
    ]);

    expect(seeds).toEqual([
      {
        id: 'el-1',
        displayName: 'Bottle',
        handle: '@bottle',
        previewUrl: 'https://signed.example.com/bottle.png',
        providerUrl: 'https://signed.example.com/bottle.png',
        storagePath: 'uploads/user-1/bottle.png',
        sourceGenerationId: null,
        source: 'remix',
      },
    ]);
  });

  it('creates a reusable result-reference element for image remix', () => {
    const bundle: RemixSourceBundle = {
      generation: {
        id: 'source-1',
        title: 'Hero frame',
        prompt: 'Prompt',
        category: 'image',
        model: 'nano-banana-2',
      },
      result: {
        mediaType: 'image',
        url: 'https://signed.example.com/source-1.png',
      },
      inputs: {
        image: {
          elements: [],
        },
      },
      workflowSettings: {},
      restoreIssues: [],
    };

    const referenceElement = createRemixResultReferenceElement(bundle);
    expect(referenceElement).toMatchObject({
      displayName: getRemixResultReferenceLabel('Hero frame'),
      providerUrl: 'https://signed.example.com/source-1.png',
      previewUrl: 'https://signed.example.com/source-1.png',
      sourceGenerationId: 'source-1',
      source: 'remix',
    });
  });

  it('creates restored asset state for frame and motion inputs', () => {
    expect(
      createRestoredRemixAssetState({
        kind: 'video',
        label: 'Reference video',
        storagePath: 'uploads/user-1/reference.mp4',
        sourceGenerationId: null,
        url: 'https://signed.example.com/reference.mp4',
      })
    ).toEqual({
      url: 'https://signed.example.com/reference.mp4',
      descriptor: {
        kind: 'video',
        label: 'Reference video',
        storagePath: 'uploads/user-1/reference.mp4',
        sourceGenerationId: null,
      },
    });
  });

  it('returns a lightweight restore warning when remix media is missing', () => {
    expect(getRemixRestoreWarning([])).toBeNull();
    expect(getRemixRestoreWarning(['video-start-frame'])).toContain('could not be restored');
  });
});

