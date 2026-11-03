import { describe, expect, it } from 'vitest';
import {
  buildRemixInputSlots,
  openRemixInputSlots,
  parseRemixInputSlots,
  readRemixSlotMentions,
  remixInputSlotRoleFor,
  REMIX_INPUT_SLOTS_NOTICE_LABEL,
  remixInputSlotAction,
  remixInputSlotHandles,
  remixInputSlotsByPlace,
  remixInputSlotsNotice,
  remixInputSlotTitle,
  remixSlotFillNaming,
  remixSlotMentionsMessage,
  SINGLE_USE_REMIX_SLOT_ROLES,
  unfilledRemixSlotsMessage,
  unplacedRemixSlotsMessage,
  withRemixSlotEnhancerReferences,
  type RemixInputSlot,
  type RemixInputSlotSource,
} from '../../ugc-mobile/lib/remix-input-slots/remix-input-slots';

const input = (
  mediaType: string,
  role: string,
  sortOrder: number,
  metadata: Record<string, unknown> = {},
): RemixInputSlotSource => ({ mediaType, role, sortOrder, metadata });

// Owner, 2026-11-03: a remix not given the creator's inputs gets empty slots
// named as the prompt names them, to add the remixer's own.
describe('remix input slots', () => {
  it('names an image run’s references in order, with the handles its prompt mentions', () => {
    const slots = buildRemixInputSlots([
      input('image', 'reference_image', 1, { handle: '@backdrop', displayName: 'IMG_2201' }),
      input('image', 'reference_image', 0, { handle: '@product', displayName: 'my-passport.jpg' }),
    ], { tool: 'image', prompt: 'Place @product on a marble counter, soft light' });

    expect(slots).toEqual([
      { id: 'slot-1', kind: 'image', role: 'reference_image', handle: '@product', name: 'Reference image 1' },
      // Not in the prompt, so its handle (which can come from a file's name) stays out.
      { id: 'slot-2', kind: 'image', role: 'reference_image', handle: null, name: 'Reference image 2' },
    ]);
    // Nothing of the creator's file reaches a slot.
    expect(JSON.stringify(slots)).not.toMatch(/IMG_2201|passport|displayName/);
  });

  // A slot says what goes there and nothing of what was there: no clip's length, no subject's picture count.
  it('gives a video run its frames once each, its clips and tracks, and one slot per subject', () => {
    const slots = buildRemixInputSlots([
      input('image', 'start_frame', 0),
      input('image', 'end_frame', 1),
      input('image', 'start_frame', 2),
      input('video', 'reference_video', 3, { handle: '@dance', durationSeconds: 4.2 }),
      input('audio', 'reference_audio', 4, { durationSeconds: 'long' }),
      input('image', 'subject_image', 5, { handle: '@maya', subjectIndex: 0 }),
      input('image', 'subject_image', 6, { handle: '@maya', subjectIndex: 0 }),
      input('image', 'subject_image', 7, { subjectIndex: 1 }),
      input('image', 'character_image', 8),
    ], { tool: 'video', prompt: '@maya dances like @dance' });

    expect(slots).toEqual([
      { id: 'slot-1', kind: 'image', role: 'start_frame', handle: null, name: 'Start frame' },
      { id: 'slot-2', kind: 'image', role: 'end_frame', handle: null, name: 'End frame' },
      { id: 'slot-3', kind: 'video', role: 'reference_video', handle: '@dance', name: 'Reference video 1' },
      { id: 'slot-4', kind: 'audio', role: 'reference_audio', handle: null, name: 'Reference audio 1' },
      { id: 'slot-5', kind: 'image', role: 'subject', handle: '@maya', name: 'Subject 1' },
      { id: 'slot-6', kind: 'image', role: 'subject', handle: null, name: 'Subject 2' },
    ]);
  });

  // A story stores its first shot as the creation's prompt; every shot reaches the remixer, and a
  // handle only a later shot names read as an unknown mention, its box as "Subject 2" (2026-11-03).
  it('keeps a handle any of the words mention: the prompt and each of a story’s shots', () => {
    const subjects = [
      input('image', 'subject_image', 0, { handle: '@hero', subjectIndex: 0 }),
      input('image', 'subject_image', 1, { handle: '@villain', subjectIndex: 1 }),
      input('video', 'reference_video', 2, { handle: '@chase' }),
    ];

    expect(buildRemixInputSlots(subjects, { tool: 'video', prompt: ['@hero walks in.', '@villain waits.', null, 'They run like @chase'] }).map((slot) => slot.handle))
      .toEqual(['@hero', '@villain', '@chase']);
    expect(buildRemixInputSlots(subjects, { tool: 'video', prompt: '@hero walks in.' }).map((slot) => slot.handle))
      .toEqual(['@hero', null, null]);
    // Two shots read apart: a handle is never made of the end of one and the start of the next.
    expect(buildRemixInputSlots([input('image', 'reference_image', 0, { handle: '@ab' })], { tool: 'video', prompt: ['@a', 'b'] }).map((slot) => slot.handle))
      .toEqual([null]);
  });

  it('reads each input’s slot role as the builder does, and names the roles a run holds one of', () => {
    expect(remixInputSlotRoleFor(input('image', 'reference_image', 0), 'motion')).toBe('character_image');
    expect(remixInputSlotRoleFor(input('video', 'reference_video', 0), 'video')).toBe('reference_video');
    expect(remixInputSlotRoleFor(input('image', 'subject_image', 0), 'image')).toBeNull();
    expect([...SINGLE_USE_REMIX_SLOT_ROLES].sort()).toEqual(['character_image', 'end_frame', 'motion_reference_video', 'start_frame']);
  });

  it('reads a motion run as one character and one clip, whatever roles the catalog path stored', () => {
    expect(buildRemixInputSlots([
      input('image', 'reference_image', 0),
      input('video', 'reference_video', 1, { durationSeconds: 8 }),
      input('image', 'reference_image', 2),
    ], { tool: 'motion', prompt: '' })).toEqual([
      { id: 'slot-1', kind: 'image', role: 'character_image', handle: null, name: 'Character image' },
      { id: 'slot-2', kind: 'video', role: 'motion_reference_video', handle: null, name: 'Motion video' },
    ]);
  });

  it('leaves out what no creator restores', () => {
    expect(buildRemixInputSlots([
      input('image', 'start_frame', 0),
      input('video', 'reference_video', 1),
      input('image', 'mystery', 2),
    ], { tool: 'image', prompt: null })).toEqual([]);
    expect(buildRemixInputSlots([input('video', 'reference_image', 0)], { tool: 'video', prompt: '' })).toEqual([]);
  });

  it('reads a bundle’s slots defensively', () => {
    expect(parseRemixInputSlots([
      { id: 'slot-1', kind: 'video', role: 'reference_image', handle: '@product', name: ' Reference image 1 ', durationSeconds: 3 },
      { id: 'slot-2', role: 'subject', handle: '@Bad Handle', name: '', pictureCount: 2.7 },
      { id: '', role: 'start_frame' },
      { id: 'slot-4', role: 'storage_path' },
      null,
      'slot-5',
    ])).toEqual([
      // Kind follows the role, and nothing else the bundle sent is kept.
      { id: 'slot-1', kind: 'image', role: 'reference_image', handle: '@product', name: 'Reference image 1' },
      { id: 'slot-2', kind: 'image', role: 'subject', handle: null, name: 'Subject' },
    ]);
    expect(parseRemixInputSlots(undefined)).toEqual([]);
    expect(parseRemixInputSlots({ id: 'slot-1' })).toEqual([]);
  });

  it('says what each empty box wants and what the remix is missing', () => {
    expect(remixInputSlotTitle({ handle: '@product', name: 'Reference image 1' })).toBe('@product');
    expect(remixInputSlotTitle({ handle: null, name: 'Start frame' })).toBe('Start frame');
    expect(remixInputSlotAction({ kind: 'image', role: 'start_frame' })).toBe('Add your image');
    expect(remixInputSlotAction({ kind: 'video', role: 'motion_reference_video' })).toBe('Add your video');
    expect(remixInputSlotAction({ kind: 'audio', role: 'reference_audio' })).toBe('Add your audio');
    expect(remixInputSlotAction({ kind: 'image', role: 'subject' })).toBe('Add your pictures');

    expect(remixInputSlotsNotice(0)).toBeNull();
    expect(remixInputSlotsNotice(1)).toBe('The creator kept 1 input to themselves. Add your own in the empty box.');
    expect(remixInputSlotsNotice(3)).toBe('The creator kept 3 inputs to themselves. Add your own in the empty boxes.');

    expect(unfilledRemixSlotsMessage([])).toBeNull();
    expect(unfilledRemixSlotsMessage(['@product', '@product'])).toBe('Add your own for @product in its box, or take @product out of the prompt.');
    expect(unfilledRemixSlotsMessage(['@product', '@backdrop', '@dance'])).toBe('Add your own for @product, @backdrop and @dance in their boxes, or take them out of the prompt.');
    expect(remixInputSlotHandles([{ handle: '@product' }, { handle: null }])).toEqual(['@product']);
    // The notice's own name, which both creators show over it.
    expect(REMIX_INPUT_SLOTS_NOTICE_LABEL).toBe('Remix source');
  });

  const product: RemixInputSlot = { id: 'slot-1', kind: 'image', role: 'reference_image', handle: '@product', name: 'Reference image 1' };
  const backdrop: RemixInputSlot = { id: 'slot-2', kind: 'image', role: 'reference_image', handle: null, name: 'Reference image 2' };
  const dance: RemixInputSlot = { id: 'slot-3', kind: 'video', role: 'reference_video', handle: '@dance', name: 'Reference video 1' };
  const start: RemixInputSlot = { id: 'slot-4', kind: 'image', role: 'start_frame', handle: null, name: 'Start frame' };

  // A switch to a model (or a setting) with no place for a box's kind hides the box: its mention
  // said "Unknown element mention" until 2026-11-03, as if the remix had never had it.
  it('says the chosen model has no place for a box the prompt names: switch back, or take the mention out', () => {
    expect(unplacedRemixSlotsMessage([], 'Z-Image')).toBeNull();
    expect(unplacedRemixSlotsMessage(['@product', '@product'], 'Z-Image'))
      .toBe('Z-Image has no place for @product. Switch back, or take @product out of the prompt.');
    expect(unplacedRemixSlotsMessage(['@product', '@backdrop', '@dance'], 'Kling 3.0'))
      .toBe('Kling 3.0 has no place for @product, @backdrop and @dance. Switch back, or take them out of the prompt.');
    expect(unplacedRemixSlotsMessage(['@product'], null))
      .toBe('This model has no place for @product. Switch back, or take @product out of the prompt.');
    expect(unplacedRemixSlotsMessage(['@product'], '  '))
      .toBe('This model has no place for @product. Switch back, or take @product out of the prompt.');
  });

  it('sorts the boxes by whether the chosen model has a place for their kind, and keeps them all before it is known', () => {
    expect(remixInputSlotsByPlace([product, dance, start], new Set(['reference_video', 'start_frame'])))
      .toEqual({ placed: [dance, start], unplaced: [product] });
    expect(remixInputSlotsByPlace([product, dance], new Set())).toEqual({ placed: [], unplaced: [product, dance] });
    expect(remixInputSlotsByPlace([product, dance], null)).toEqual({ placed: [product, dance], unplaced: [] });
  });

  // Kling 3.0 takes clips under the handles its prompt mentions them by; a plain-clip model (Seedance 2)
  // takes none, so a box for "@dance" there held the run for a mention its fill could never answer.
  it('has no place for a clip the prompt names on a model whose clips take no handle', () => {
    const plainClip: RemixInputSlot = { ...dance, id: 'slot-5', handle: null, name: 'Reference video 2' };
    const roles = new Set<RemixInputSlot['role']>(['reference_video', 'reference_image']);

    expect(remixInputSlotsByPlace([product, dance, plainClip], roles, { clipsTakeHandles: false }))
      .toEqual({ placed: [product, plainClip], unplaced: [dance] });
    expect(remixInputSlotsByPlace([product, dance, plainClip], roles, { clipsTakeHandles: true }))
      .toEqual({ placed: [product, dance, plainClip], unplaced: [] });
    // Before the model is known its clips are not either: every box keeps its place.
    expect(remixInputSlotsByPlace([dance], null)).toEqual({ placed: [dance], unplaced: [] });
    expect(remixInputSlotsByPlace([dance], null, { clipsTakeHandles: false })).toEqual({ placed: [], unplaced: [dance] });
  });

  // One rule for both creators (2026-11-03): the web kept a box its reference already answered, and
  // named a fill "Reference image 1" where the app named it "product".
  it('opens only the boxes nothing the remix holds answers', () => {
    expect(openRemixInputSlots([product, backdrop, dance], ['@product'])).toEqual([backdrop, dance]);
    expect(openRemixInputSlots([product, backdrop], new Set(['@reference_image_2']))).toEqual([product, backdrop]);
    expect(openRemixInputSlots([product], [])).toEqual([product]);
  });

  it('names a fill for the handle the prompt mentions its box by, or else for the box', () => {
    expect(remixSlotFillNaming(product)).toEqual({ displayName: 'product', handle: '@product' });
    expect(remixSlotFillNaming({ handle: '@red_sneaker__2', name: 'Reference image 1' })).toEqual({ displayName: 'red sneaker 2', handle: '@red_sneaker__2' });
    // A box with no handle is named for itself, and its fill takes a handle as any reference added under that name.
    expect(remixSlotFillNaming(backdrop)).toEqual({ displayName: 'Reference image 2', handle: null });
    expect(remixSlotFillNaming(start)).toEqual({ displayName: 'Start frame', handle: null });
  });

  it('reads a prompt’s unknown mentions against the boxes on the page and those the model has no place for', () => {
    expect(readRemixSlotMentions(['@ghost', '@product', '@dance'], { placed: [product, backdrop], unplaced: [dance] }))
      .toEqual({ waiting: ['@product'], unplaced: ['@dance'], other: ['@ghost'] });
    // A box on the page answers its handle first.
    expect(readRemixSlotMentions(['@product'], { placed: [product], unplaced: [{ handle: '@product' }] }))
      .toEqual({ waiting: ['@product'], unplaced: [], other: [] });
    // A box with no handle answers no mention, and no box at all leaves every mention unknown.
    expect(readRemixSlotMentions(['@reference_image_2'], { placed: [backdrop] }))
      .toEqual({ waiting: [], unplaced: [], other: ['@reference_image_2'] });
    expect(readRemixSlotMentions([], { placed: [product], unplaced: [dance] })).toEqual({ waiting: [], unplaced: [], other: [] });

    expect(remixSlotMentionsMessage({ waiting: ['@product'], unplaced: ['@dance'] }, 'Kling 3.0')).toBe(
      'Add your own for @product in its box, or take @product out of the prompt. Kling 3.0 has no place for @dance. Switch back, or take @dance out of the prompt.',
    );
    expect(remixSlotMentionsMessage({ waiting: [], unplaced: ['@dance'] }, 'Kling 3.0'))
      .toBe('Kling 3.0 has no place for @dance. Switch back, or take @dance out of the prompt.');
    expect(remixSlotMentionsMessage({ waiting: [], unplaced: [] }, 'Kling 3.0')).toBeNull();
  });

  // An Enhance rewrote "@product" out of a remix's prompt and left its box with nothing to answer
  // (2026-11-03): the enhancer keeps a handle only when it is told of it.
  it('has Enhance keep each empty box’s handle the words mention, beside the references a run sends, each handle once', () => {
    const sent = [{ handle: '@bottle', displayName: 'bottle' }];
    const prompt = '@product beside @bottle, then @dance';
    expect(withRemixSlotEnhancerReferences(sent, [
      product,
      backdrop,
      dance,
      { ...start, handle: '@bottle' },
      { ...product, id: 'slot-9', name: 'Subject 1' },
    ], prompt)).toEqual([
      { handle: '@bottle', displayName: 'bottle' },
      // Named as the box's fill will be (`remixSlotFillNaming`), so Enhance reads a box and its fill alike.
      { handle: '@product', displayName: 'product' },
      { handle: '@dance', displayName: 'dance' },
    ]);
    // A box the words do not mention has nothing to keep, and is no reference of the run.
    expect(withRemixSlotEnhancerReferences(sent, [product, dance], 'A bottle on @bottle_stand')).toEqual(sent);
    expect(withRemixSlotEnhancerReferences([], [backdrop], '@reference_image_2')).toEqual([]);
    expect(withRemixSlotEnhancerReferences(sent, [], prompt)).toEqual(sent);
    expect(withRemixSlotEnhancerReferences([], [product], null)).toEqual([]);
  });
});
