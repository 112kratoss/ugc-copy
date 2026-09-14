import { describe, expect, it } from 'vitest';
import { generationReferences } from '@/lib/generation-references';

describe('owner generation reference presentation', () => {
  it('preserves the stored handle and media type for images, frames, audio and motion', () => {
    expect(generationReferences([
      { id: 'audio', mediaType: 'audio', role: 'reference_audio', sortOrder: 3 },
      { id: 'image', mediaType: 'image', role: 'reference_image', label: 'Image input', metadata: { handle: '@alisa' }, url: 'https://signed.test/image', sortOrder: 0 },
      { id: 'frame', mediaType: 'image', role: 'start_frame', sortOrder: 1 },
      { id: 'motion', mediaType: 'video', role: 'motion_reference_video', sortOrder: 2 },
    ])).toEqual([
      { id: 'image', mediaKind: 'image', label: '@alisa', caption: 'Reference image', url: 'https://signed.test/image' },
      { id: 'frame', mediaKind: 'image', label: 'Start frame', caption: 'Start frame', url: null },
      { id: 'motion', mediaKind: 'video', label: 'Motion reference video', caption: 'Motion reference video', url: null },
      { id: 'audio', mediaKind: 'audio', label: 'Reference audio', caption: 'Reference audio', url: null },
    ]);
  });

  it('keeps unavailable references visible and supports legacy kind values', () => {
    expect(generationReferences([{ storagePath: 'uploads/owner/file', kind: 'video', label: 'My reference', url: null }]))
      .toEqual([{ id: 'uploads/owner/file', mediaKind: 'video', label: 'My reference', caption: 'Reference video', url: null }]);
    expect(generationReferences()).toEqual([]);
  });
});
