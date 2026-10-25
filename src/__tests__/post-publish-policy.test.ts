import { describe, expect, it } from 'vitest';

import {
  isPlaceholderText,
  suggestCreationPostTitle,
  suggestProfileHandle,
} from '../../ugc-mobile/lib/post-publish-policy/post-publish-policy';

// Most creations have no title of their own (22 of 98 on production,
// 2026-10-25), so both composers suggest one instead of asking for typing.
describe('the title suggested for a post of a creation', () => {
  const suggest = (prompt: string | null, overrides: Partial<Parameters<typeof suggestCreationPostTitle>[0]> = {}) =>
    suggestCreationPostTitle({ prompt, model: 'nano-banana-2', category: 'image', hasRecipe: false, ...overrides });

  it('cuts the opening of the prompt at a word, to eight words', () => {
    expect(suggest('A young woman in a white jacket dancing in an empty parking lot at sunset, handheld camera, cinematic'))
      .toEqual({ title: 'Young woman in a white jacket dancing', source: 'prompt' });
    expect(suggest('fake mask')).toEqual({ title: 'Fake mask', source: 'prompt' });
  });

  it('keeps whole comma clauses while they fit', () => {
    expect(suggest('A product still lit like a window display, soft morning light, 85mm').title)
      .toBe('Product still lit like a window display');
    expect(suggest('Close-up, a woman smiling at the camera').title).toBe('Close-up, a woman smiling at the camera');
  });

  it('drops the request around the subject and the sentences after it', () => {
    expect(suggest('Create a video of a cat surfing a giant wave. Slow motion, golden hour.').title)
      .toBe('Cat surfing a giant wave');
    expect(suggest('"A red fox in fresh snow"').title).toBe('Red fox in fresh snow');
    expect(suggest('Scene 1: a woman walks through a neon market at night').title)
      .toBe('Woman walks through a neon market at night');
  });

  it('leaves out links and @image-style references', () => {
    expect(suggest('@image1 walks into frame like the person in @video1').title).toBe('Walks into frame like the person');
    expect(suggest('https://example.com/ref.png').source).toBe('kind');
  });

  it('never ends on a joining word', () => {
    expect(suggest('Portrait of an old fisherman mending nets by the harbor with gulls').title)
      .toBe('Portrait of an old fisherman mending nets');
  });

  it('keeps every suggestion within sixty characters, in any script', () => {
    const long = suggest('Extraordinarilylongwordsthatkeepgoing andgoingwithoutanybreakatall forthewholeprompt').title;
    expect(long.length).toBeLessThanOrEqual(60);
    expect(suggest('एक लड़की समुद्र किनारे नाच रही है').title).toBe('एक लड़की समुद्र किनारे नाच रही है');
  });

  it('never suggests the prompt while the post has a recipe, which keeps the prompt private', () => {
    expect(suggest('Neon samurai walking through rain', { hasRecipe: true }))
      .toEqual({ title: 'Image recipe', source: 'kind' });
    expect(suggest('Neon samurai walking through rain', { hasRecipe: true, category: 'video', model: 'seedance-2' }).title)
      .toBe('Video recipe');
  });

  it('names what was made when the prompt gives no title', () => {
    expect(suggest(null)).toEqual({ title: 'AI image', source: 'kind' });
    expect(suggest('test')).toEqual({ title: 'AI image', source: 'kind' });
    expect(suggest('', { category: 'video', model: 'kling-3.0-video' }).title).toBe('AI video');
    // Motion control creations carry no category, only the model.
    expect(suggest(null, { category: null, model: 'kling-2.6/motion-control' }).title).toBe('Motion transfer');
  });

  it('only suggests titles the public-post rule takes', () => {
    for (const prompt of ['test test', 'Demo video of a', 'asdf', 'Untitled creation', '!!!', 'Lorem ipsum dolor']) {
      const { title } = suggest(prompt);
      expect(isPlaceholderText(title), `${prompt} → ${title}`).toBe(false);
    }
  });
});

// A new account's handle is `creator-xxxxxxxx`, which cannot publish publicly;
// the composers offer one instead of sending the creator to their profile.
describe('the handle suggested to a creator who has none', () => {
  it('builds it from the name, else the email', () => {
    expect(suggestProfileHandle('Athul S')).toBe('athul-s');
    expect(suggestProfileHandle('Sassy23b')).toBe('sassy23b');
    expect(suggestProfileHandle('Zoë Ünal')).toBe('zoe-unal');
    expect(suggestProfileHandle('अतुल', 'athul.s@example.com')).toBe('athul-s');
    expect(suggestProfileHandle(null, 'maya_k@example.com')).toBe('maya-k');
  });

  it('keeps to the handle rule: 3 to 24 of a-z, 0-9 and hyphens, never the signup placeholder', () => {
    expect(suggestProfileHandle('A very long display name that goes on')).toBe('a-very-long-display-name');
    expect(suggestProfileHandle('Al')).toBe('');
    expect(suggestProfileHandle('creator-1a2b3c4d')).toBe('');
    expect(suggestProfileHandle('  --Neon  Lab--  ')).toBe('neon-lab');
  });
});
