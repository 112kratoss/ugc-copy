import { describe, expect, it } from 'vitest';

import {
  buildTextPostPlate,
  TEXT_POST_PLATE_FALLBACK,
  textPostPlateBodyLines,
  textPostPlateUnderCaption,
} from '../lib/text-post-plate-view-model';

describe('buildTextPostPlate', () => {
  it('names the post and gives its writing under the name', () => {
    expect(buildTextPostPlate({ title: 'Creative Idea', body: 'Exploring the app features.' })).toEqual({
      title: 'Creative Idea',
      body: 'Exploring the app features.',
    });
  });

  it('folds line breaks, so a clamped tile spends no line on a blank one', () => {
    expect(buildTextPostPlate({ title: ' Hook\n', body: 'Line one\n\nLine two\t end ' })).toEqual({
      title: 'Hook',
      body: 'Line one Line two end',
    });
  });

  it('does not say a title twice when the writing only repeats it', () => {
    expect(buildTextPostPlate({ title: 'Test Title', body: 'test title' })).toEqual({ title: 'Test Title', body: null });
  });

  it('reads a text creation from its prompt', () => {
    expect(buildTextPostPlate({ title: 'Untitled', body: '', prompt: 'A caption about rain' })).toEqual({
      title: 'Untitled',
      body: 'A caption about rain',
    });
  });

  it('shows the writing alone when the post has no title', () => {
    expect(buildTextPostPlate({ title: '  ', body: 'Only words' })).toEqual({ title: null, body: 'Only words' });
  });

  it('never draws an empty plate', () => {
    expect(buildTextPostPlate({ title: null, body: null })).toEqual({ title: TEXT_POST_PLATE_FALLBACK, body: null });
  });
});

describe('textPostPlateUnderCaption', () => {
  it('leaves the title to the caption under the frame', () => {
    expect(textPostPlateUnderCaption({ title: 'Creative Idea', body: 'Words' })).toEqual({ title: null, body: 'Words' });
  });

  it('keeps the title when it is all there is to show', () => {
    expect(textPostPlateUnderCaption({ title: 'Creative Idea', body: null })).toEqual({ title: 'Creative Idea', body: null });
  });
});

describe('textPostPlateBodyLines', () => {
  it('fits whole lines between the corner marks of a profile tile', () => {
    // 153pt tile: 46 above for the type mark, 38 below for the state mark, a 20pt title.
    expect(textPostPlateBodyLines({ height: 153, paddingTop: 46, paddingBottom: 38, titleHeight: 20, lineHeight: 16 })).toBe(3);
  });

  it('gives a narrower phone fewer lines rather than a cut one', () => {
    expect(textPostPlateBodyLines({ height: 139, paddingTop: 46, paddingBottom: 38, titleHeight: 20, lineHeight: 16 })).toBe(2);
  });

  it('always leaves one line', () => {
    expect(textPostPlateBodyLines({ height: 80, paddingTop: 46, paddingBottom: 38, titleHeight: 20, lineHeight: 16 })).toBe(1);
  });
});
