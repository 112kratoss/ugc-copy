import { describe, expect, it } from 'vitest';
import {
  buildRemixInputSlots,
  parseRemixInputSlots,
  readRemixSlotMentions,
  REMIX_INPUT_SLOTS_NOTICE_LABEL,
  remixInputSlotAction,
  remixInputSlotHandles,
  remixInputSlotsByPlace,
  remixInputSlotsNotice,
  remixInputSlotTitle,
  remixSlotMentionsMessage,
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

  it('gives a video run its frames once each, its clips and tracks with their lengths, and one slot per subject', () => {
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
      { id: 'slot-3', kind: 'video', role: 'reference_video', handle: '@dance', name: 'Reference video 1', durationSeconds: 4.2 },
      { id: 'slot-4', kind: 'audio', role: 'reference_audio', handle: null, name: 'Reference audio 1' },
      { id: 'slot-5', kind: 'image', role: 'subject', handle: '@maya', name: 'Subject 1', pictureCount: 2 },
      { id: 'slot-6', kind: 'image', role: 'subject', handle: null, name: 'Subject 2', pictureCount: 1 },
    ]);
  });

  it('reads a motion run as one character and one clip, whatever roles the catalog path stored', () => {
    expect(buildRemixInputSlots([
      input('image', 'reference_image', 0),
      input('video', 'reference_video', 1, { durationSeconds: 8 }),
      input('image', 'reference_image', 2),
    ], { tool: 'motion', prompt: '' })).toEqual([
      { id: 'slot-1', kind: 'image', role: 'character_image', handle: null, name: 'Character image' },
      { id: 'slot-2', kind: 'video', role: 'motion_reference_video', handle: null, name: 'Motion video', durationSeconds: 8 },
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
      // Kind follows the role, and a picture has no length.
      { id: 'slot-1', kind: 'image', role: 'reference_image', handle: '@product', name: 'Reference image 1' },
      { id: 'slot-2', kind: 'image', role: 'subject', handle: null, name: 'Subject', pictureCount: 2 },
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
      { handle: '@product', displayName: 'Reference image 1' },
      { handle: '@dance', displayName: 'Reference video 1' },
    ]);
    // A box the words do not mention has nothing to keep, and is no reference of the run.
    expect(withRemixSlotEnhancerReferences(sent, [product, dance], 'A bottle on @bottle_stand')).toEqual(sent);
    expect(withRemixSlotEnhancerReferences([], [backdrop], '@reference_image_2')).toEqual([]);
    expect(withRemixSlotEnhancerReferences(sent, [], prompt)).toEqual(sent);
    expect(withRemixSlotEnhancerReferences([], [product], null)).toEqual([]);
  });
});
