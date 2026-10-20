import { describe, expect, it } from 'vitest';

import {
  createRemixElementSeeds,
  createRemixResultReferenceElement,
  createRestoredRemixAssetState,
  getRemixRestoreWarning,
  getRemixResultReferenceLabel,
  getRemixReferenceCapWarning,
  joinRemixRestoreWarnings,
  REMIX_RESTORE_WARNING,
} from '@/lib/remix-source-client';
import { hasCreatorEditedPromptDuringRemix } from '@/lib/remix-source';
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

describe('remix prompt ownership', () => {
  it('lets the restore fill a prompt the creator never touched', () => {
    expect(hasCreatorEditedPromptDuringRemix('', '')).toBe(false);
  });

  it('treats a tool default the creator left alone as untouched', () => {
    const motionDefault = "No distortion, the character's movements are consistent with the video.";
    expect(hasCreatorEditedPromptDuringRemix(motionDefault, motionDefault)).toBe(false);
  });

  it('protects a prompt typed while the restore was still in flight', () => {
    expect(hasCreatorEditedPromptDuringRemix('my own idea', '')).toBe(true);
  });

  it('protects an edit made on top of a tool default', () => {
    const motionDefault = "No distortion, the character's movements are consistent with the video.";
    expect(hasCreatorEditedPromptDuringRemix('a dog surfing', motionDefault)).toBe(true);
  });

  it('does not count clearing the field as creator input worth keeping', () => {
    expect(hasCreatorEditedPromptDuringRemix('   ', 'something')).toBe(false);
  });
});

describe('a remix whose model now takes fewer references', () => {
  const element = (index: number, url: string | null = `https://signed.example.com/${index}.png`) => ({
    id: `remix-${index}`,
    displayName: `Ref ${index}`,
    handle: `@ref_${index}`,
    url,
    storagePath: null,
    sourceGenerationId: 'gen-1',
  });

  it('says how many came back when the cap left some out, and nothing when it did not', () => {
    const twelve = Array.from({ length: 12 }, (_, index) => element(index + 1));
    expect(getRemixReferenceCapWarning(twelve, 10, 'Nano Banana 2.0'))
      .toBe("Nano Banana 2.0 takes up to 10 reference images, so 10 of this run's 12 came back.");
    expect(getRemixReferenceCapWarning(twelve.slice(0, 10), 10, 'Nano Banana 2.0')).toBeNull();
    // Unusable references (no link) are not counted as left out.
    expect(getRemixReferenceCapWarning([...twelve.slice(0, 5), element(6, null)], 5, 'MiniMax H3')).toBeNull();
    expect(getRemixReferenceCapWarning(twelve.slice(0, 2), 1, 'Grok Imagine'))
      .toBe("Grok Imagine takes up to 1 reference image, so 1 of this run's 2 came back.");
  });

  it('gives a reference that cannot come back its place to the next one', () => {
    const withLinkless = [element(1, null), ...Array.from({ length: 11 }, (_, index) => element(index + 2))];

    expect(createRemixElementSeeds(withLinkless, 10).map((seed) => seed.id))
      .toEqual(Array.from({ length: 10 }, (_, index) => `remix-${index + 2}`));
    expect(getRemixReferenceCapWarning(withLinkless, 10, 'Nano Banana 2.0'))
      .toBe("Nano Banana 2.0 takes up to 10 reference images, so 10 of this run's 11 came back.");
  });

  it('puts a cap notice after a restore problem', () => {
    expect(joinRemixRestoreWarnings(null, 'Cap.')).toBe('Cap.');
    expect(joinRemixRestoreWarnings('Restore.', 'Cap.')).toBe('Restore. Cap.');
    expect(joinRemixRestoreWarnings('Restore.', null)).toBe('Restore.');
  });

  // A Seedance remix adds the restore notice after its cap notice; one the bundle already
  // gave is not said twice.
  it('adds a restore problem after a cap notice, and says each once', () => {
    expect(joinRemixRestoreWarnings('Cap.', REMIX_RESTORE_WARNING)).toBe(`Cap. ${REMIX_RESTORE_WARNING}`);
    expect(joinRemixRestoreWarnings(REMIX_RESTORE_WARNING, REMIX_RESTORE_WARNING)).toBe(REMIX_RESTORE_WARNING);
    expect(joinRemixRestoreWarnings(`${REMIX_RESTORE_WARNING} Cap.`, REMIX_RESTORE_WARNING))
      .toBe(`${REMIX_RESTORE_WARNING} Cap.`);
  });
});
