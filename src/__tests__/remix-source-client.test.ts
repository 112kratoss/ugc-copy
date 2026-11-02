import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRemixElementSeeds,
  createRemixResultReferenceElement,
  createRestoredRemixAssetState,
  getRemixNoticeDescription,
  getRemixRestoreWarning,
  getRemixResultReferenceLabel,
  getRemixReferenceCapWarning,
  getRemixRoomWarning,
  isRemixResultReference,
  joinRemixRestoreWarnings,
  readRemixInputSlots,
  fetchRemixSource,
  REMIX_RESTORE_WARNING,
  remixSlotsInputSide,
  withoutRemixInputSlot,
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

  // Pictures the creator added while the remix loaded stay, and take room the original's would have had.
  it('counts the pictures the creator added against the model’s room, and says so', () => {
    const ten = Array.from({ length: 10 }, (_, index) => element(index + 1));
    expect(getRemixReferenceCapWarning(ten, 10, 'Nano Banana 2.0', 1))
      .toBe("Nano Banana 2.0 takes up to 10 reference images, so with the 1 you added, 9 of this run's 10 came back.");
    expect(getRemixReferenceCapWarning(ten.slice(0, 2), 2, 'Seedance 1.5 Pro', 2))
      .toBe("Seedance 1.5 Pro takes up to 2 reference images, so with the 2 you added, 0 of this run's 2 came back.");
    // Room enough beside them: nothing to say.
    expect(getRemixReferenceCapWarning(ten.slice(0, 3), 10, 'Nano Banana 2.0', 7)).toBeNull();
  });

  it('says the same of any kind of reference', () => {
    expect(getRemixRoomWarning({ modelName: 'Kling 3.0', limit: 3, noun: 'video element', usable: 2, restored: 1, added: 2 }))
      .toBe("Kling 3.0 takes up to 3 video elements, so with the 2 you added, 1 of this run's 2 came back.");
    expect(getRemixRoomWarning({ modelName: 'Kling O3', limit: 1, noun: 'named subject', usable: 2, restored: 1 }))
      .toBe("Kling O3 takes up to 1 named subject, so 1 of this run's 2 came back.");
    expect(getRemixRoomWarning({ modelName: 'Kling 3.0', limit: 3, noun: 'video element', usable: 1, restored: 1, added: 2 })).toBeNull();
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

// The image, video and motion creators each said whether the run held the original their own way
// (its name, its link, its creation), and the image creator's name test lost it on a rename.
describe('isRemixResultReference', () => {
  it('knows the original by the creation it came from, held by its link alone', () => {
    expect(isRemixResultReference({ sourceGenerationId: 'gen-1', storagePath: null }, 'gen-1')).toBe(true);
    expect(isRemixResultReference({ sourceGenerationId: 'gen-1' }, 'gen-1')).toBe(true);
  });

  it('takes nothing else for it', () => {
    // A file of the creator's own in its place (Replace), the run's own kept inputs, another creation's result.
    expect(isRemixResultReference({ sourceGenerationId: 'gen-1', storagePath: 'uploads/viewer-1/clip.mp4' }, 'gen-1')).toBe(false);
    expect(isRemixResultReference({ sourceGenerationId: 'gen-1', storagePath: 'generation_inputs/owner-1/gen-1/00.png' }, 'gen-1')).toBe(false);
    expect(isRemixResultReference({ sourceGenerationId: 'gen-7', storagePath: null }, 'gen-1')).toBe(false);
    expect(isRemixResultReference({ sourceGenerationId: null, storagePath: null }, 'gen-1')).toBe(false);
    // No reference, or no remix.
    expect(isRemixResultReference(null, 'gen-1')).toBe(false);
    expect(isRemixResultReference({ sourceGenerationId: 'gen-1', storagePath: null }, null)).toBe(false);
  });
});

// Owner, 2026-11-03: a remix not given the creator's inputs gets an empty box for each, named as
// the prompt names it, for the remixer's own; the prompt then works unchanged.
describe('a remix’s empty slots in the web creators', () => {
  const product = { id: 'slot-1', kind: 'image', role: 'reference_image', handle: '@product', name: 'Reference image 1' } as const;
  const backdrop = { id: 'slot-2', kind: 'image', role: 'reference_image', handle: null, name: 'Reference image 2' } as const;

  it('reads the slots a bundle names, and none from a bundle without them', () => {
    expect(readRemixInputSlots({ inputSlots: [product, backdrop, { id: 'slot-3', role: 'storage_path' } as never] }))
      .toEqual([product, backdrop]);
    expect(readRemixInputSlots({})).toEqual([]);
  });

  it('drops a slot once its box is filled', () => {
    expect(withoutRemixInputSlot([product, backdrop], 'slot-1')).toEqual([backdrop]);
    expect(withoutRemixInputSlot([product, backdrop], 'slot-9')).toEqual([product, backdrop]);
  });

  // What the creator kept is a notice of its own, which the remixer can put away for the remix, as
  // in the app (2026-11-03): the remix's own notice keeps the original and Use as reference.
  it('says where the remix came from and what could not be restored, and leaves the empty boxes to their own notice', () => {
    expect(getRemixNoticeDescription('Harbour', null)).toBe('Settings pre-filled from "Harbour".');
    expect(getRemixNoticeDescription(null, null)).toBe('Settings pre-filled from the original creation.');
    expect(getRemixNoticeDescription('Harbour', REMIX_RESTORE_WARNING))
      .toBe(`Settings pre-filled from "Harbour". ${REMIX_RESTORE_WARNING}`);
  });

  it('opens the video creator’s inputs where the empty boxes are', () => {
    const start = { role: 'start_frame', handle: null } as const;
    const clip = { role: 'reference_video', handle: null } as const;
    expect(remixSlotsInputSide([start, { role: 'end_frame', handle: null }], { clipsBesideSides: false })).toBe('frames');
    // A model that keeps its start image beside its references (Wan 2.7) shows the frame's box there too.
    expect(remixSlotsInputSide([start, clip], { clipsBesideSides: false })).toBe('references');
    expect(remixSlotsInputSide([{ role: 'reference_audio', handle: null }], { clipsBesideSides: false })).toBe('references');
    // Kling 3.0's clips are named video elements beside either side, and a subject is neither.
    expect(remixSlotsInputSide([clip], { clipsBesideSides: true })).toBeNull();
    expect(remixSlotsInputSide([clip, start], { clipsBesideSides: true })).toBe('frames');
    expect(remixSlotsInputSide([{ role: 'subject', handle: '@lead' }], { clipsBesideSides: false })).toBeNull();
    expect(remixSlotsInputSide([], { clipsBesideSides: false })).toBeNull();
    // A clip the prompt names has no place on a model whose clips take no handle: it opens no side.
    expect(remixSlotsInputSide([{ role: 'reference_video', handle: '@dance' }, start], { clipsBesideSides: false })).toBe('frames');
  });
});

describe('the read of a remix’s original', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const bundle: RemixSourceBundle = {
    generation: { id: 'gen-1', title: 'Harbour', prompt: 'Prompt', category: 'image', model: 'nano-banana-2' },
    result: null,
    inputs: {},
    workflowSettings: {},
    restoreIssues: [],
  };

  it('asks for the remix and its post as the session’s account', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => bundle }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchRemixSource({ id: 'gen-1', postId: 'post-1' }, 'token-1')).resolves.toEqual(bundle);
    await expect(fetchRemixSource({ id: 'gen-1', postId: null }, 'token-1')).resolves.toEqual(bundle);
    expect(fetchMock.mock.calls).toEqual([
      ['/api/remix-source?id=gen-1&postId=post-1', { headers: { Authorization: 'Bearer token-1' } }],
      ['/api/remix-source?id=gen-1', { headers: { Authorization: 'Bearer token-1' } }],
    ]);
  });

  it('throws on a refusal, with the server’s reason where it gave one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => ({ error: 'Too many requests' }) }) as Response));
    await expect(fetchRemixSource({ id: 'gen-1', postId: null }, 'token-1')).rejects.toThrow('Too many requests');

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) }) as Response));
    await expect(fetchRemixSource({ id: 'gen-1', postId: null }, 'token-1')).rejects.toThrow('Failed to load remix data');
  });
});
