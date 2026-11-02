import { describe, expect, it } from 'vitest';

import { isReferenceMediaFile } from '@/app/post/new/ResourceCardEditorDialog';

describe('a recipe reference-media card takes a file', () => {
  // Chrome names an .m4a file audio/x-m4a, and Apple's type database names a .wav
  // audio/vnd.wave; the sign step keeps both under their listed names.
  it.each([
    ['Voice Memo.m4a', 'audio/x-m4a'],
    ['Take 1.wav', 'audio/vnd.wave'],
    ['Take 2.wav', 'audio/wav'],
    ['song.mp3', 'audio/mpeg'],
  ])('%s typed %s', (name, type) => {
    expect(isReferenceMediaFile(new File(['bytes'], name, { type }))).toBe(true);
  });

  it('still refuses a document, and an alias on the wrong kind of file', () => {
    expect(isReferenceMediaFile(new File(['bytes'], 'guide.pdf', { type: 'application/pdf' }))).toBe(false);
    expect(isReferenceMediaFile(new File(['bytes'], 'clip.mp4', { type: 'audio/x-m4a' }))).toBe(false);
  });
});
