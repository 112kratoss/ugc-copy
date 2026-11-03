import { describe, expect, it } from 'vitest';
import {
  buildRemixInputSlots,
  parseRemixInputSlots,
  remixInputSlotAction,
  remixInputSlotHandles,
  remixInputSlotsNotice,
  remixInputSlotTitle,
  unfilledRemixSlotsMessage,
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
  });
});
