import { describe, expect, it } from 'vitest';

import { listFilesInSentence, nameSaysNothing, readableFileName } from '@/lib/media-file-names';

// Android's system photo picker hands a picture over under its media id ("1000333161.jpg"), so the post
// composer's cards and the upload failures read "1000333161.jpg" (redundant-UI audit, 2026-10-21).
describe('readableFileName', () => {
  it('keeps a file name with words in it', () => {
    expect(readableFileName('Bottle_shot.jpg')).toBe('Bottle_shot.jpg');
    expect(readableFileName('IMG_1234.jpg')).toBe('IMG_1234.jpg');
    expect(readableFileName('  dance.mp4 ')).toBe('dance.mp4');
  });

  // A media id, the random UUID the picker falls back to, a camera's timestamp, and what is left of a name
  // the upload could not keep: none is a name a person knows a picture by.
  it('gives no name for a file name that says nothing', () => {
    for (const fileName of ['1000333161.jpg', '3f2504e0-4f89-11d3-9a0c-0305e82c3301.jpg', '20261021_103000.jpg', '-.jpg', '143', '', '   ']) {
      expect(readableFileName(fileName)).toBeNull();
    }
    expect(readableFileName(null)).toBeNull();
    expect(readableFileName(undefined)).toBeNull();
  });

  // A picker's own name can be in any script; only the upload's copy of it is ASCII (lib/media.ts).
  it('keeps a name written in another script', () => {
    expect(readableFileName('фото.jpg')).toBe('фото.jpg');
    expect(readableFileName('写真.png')).toBe('写真.png');
  });

  it('reads the name without its extension', () => {
    expect(readableFileName('1000333161.jpeg')).toBeNull();
    expect(readableFileName('1000333161')).toBeNull();
    expect(readableFileName('cover.final.jpg')).toBe('cover.final.jpg');
  });
});

describe('nameSaysNothing', () => {
  // The rule `nameUnnamedReferences` names a picked reference by: a reference's name is its file name
  // without the extension, its separators made spaces ("3f2504e0 4f89 11d3 9a0c 0305e82c3301").
  it('reads a reference name made from a file name', () => {
    expect(nameSaysNothing('1000333161')).toBe(true);
    expect(nameSaysNothing('3f2504e0 4f89 11d3 9a0c 0305e82c3301')).toBe(true);
    expect(nameSaysNothing('20261021 103000')).toBe(true);
    expect(nameSaysNothing('Bottle shot')).toBe(false);
    expect(nameSaysNothing('IMG 1234')).toBe(false);
  });
});

describe('listFilesInSentence', () => {
  const nouns = { image: ['a picture', 'pictures'], video: ['a clip', 'clips'], audio: ['a track', 'tracks'] } as const;

  it('names each file by its name where it says something', () => {
    expect(listFilesInSentence([{ fileName: 'bravo.png', kind: 'image' }], nouns)).toBe('bravo.png');
    expect(listFilesInSentence([
      { fileName: 'bravo.png', kind: 'image' },
      { fileName: 'dance.mp4', kind: 'video' },
      { fileName: 'beat.mp3', kind: 'audio' },
    ], nouns)).toBe('bravo.png, dance.mp4 and beat.mp3');
  });

  // Three media ids used to read "1000333161.jpg, 1000333162.jpg and 1000333163.jpg", and three picks the
  // picker gave no name "a picture, a picture and a picture".
  it('counts the rest by kind', () => {
    expect(listFilesInSentence([{ fileName: '1000333161.jpg', kind: 'image' }], nouns)).toBe('a picture');
    expect(listFilesInSentence([
      { fileName: '1000333161.jpg', kind: 'image' },
      { fileName: null, kind: 'image' },
      { fileName: '1000333163.jpg', kind: 'image' },
    ], nouns)).toBe('3 pictures');
    expect(listFilesInSentence([
      { fileName: '1000333161.jpg', kind: 'image' },
      { fileName: 'bravo.png', kind: 'image' },
      { fileName: '1000333162.mp4', kind: 'video' },
      { fileName: '1000333163.jpg', kind: 'image' },
    ], nouns)).toBe('bravo.png, 2 pictures and a clip');
  });

  it('starts a sentence with a capital where it starts with a kind', () => {
    expect(listFilesInSentence([{ fileName: '1000333161.jpg', kind: 'image' }], nouns, { sentenceStart: true })).toBe('A picture');
    expect(listFilesInSentence([{ fileName: null, kind: 'video' }, { fileName: null, kind: 'video' }], nouns, { sentenceStart: true })).toBe('2 clips');
    // A file's name is written as it is.
    expect(listFilesInSentence([{ fileName: 'bravo.png', kind: 'image' }, { fileName: '143.jpg', kind: 'image' }], nouns, { sentenceStart: true })).toBe('bravo.png and a picture');
  });

  it('says nothing for no files', () => {
    expect(listFilesInSentence([], nouns)).toBe('');
  });
});
