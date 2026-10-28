import { describe, expect, it } from 'vitest';

import { titleForRecipePost } from '@/lib/creation-post-title';

// The server's half of the composers' rule: a paid recipe keeps the creation's
// prompt private, so a title cut from that prompt is stored as the recipe's
// kind title; a free one does not (owner, 2026-10-29). The services' own tests
// cover where it is applied.
describe('the title a post with a paid recipe is stored with', () => {
  const source = {
    prompt: 'A product still lit like a window display, soft morning light, 85mm',
    model: 'nano-banana-2',
    category: 'image',
    creationMode: null,
  };
  const fromPrompt = 'Product still lit like a window display';

  it('is the recipe’s kind title when the title is the prompt’s opening', () => {
    expect(titleForRecipePost({ title: fromPrompt, promptPrivate: true, source })).toBe('Image recipe');
    expect(titleForRecipePost({ title: fromPrompt.toUpperCase(), promptPrivate: true, source })).toBe('Image recipe');
    expect(titleForRecipePost({
      title: 'Cat surfing a giant wave at sunset',
      promptPrivate: true,
      source: { prompt: 'A cat surfing a giant wave at sunset', model: 'veo-3', category: 'video', creationMode: null },
    })).toBe('Video recipe');
  });

  it('is the title as given otherwise', () => {
    expect(titleForRecipePost({ title: 'Window still', promptPrivate: true, source })).toBe('Window still');
    expect(titleForRecipePost({ title: fromPrompt, promptPrivate: false, source })).toBe(fromPrompt);
    expect(titleForRecipePost({ title: fromPrompt, promptPrivate: true, source: null })).toBe(fromPrompt);
    expect(titleForRecipePost({ title: null, promptPrivate: true, source })).toBeNull();
  });
});
