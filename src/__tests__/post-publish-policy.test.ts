import { describe, expect, it } from 'vitest';

import {
  followTitleForPromptPrivacy,
  GENERIC_SUGGESTED_TITLES,
  isPlaceholderText,
  isTitleFromPrompt,
  describeTitleSuggestion,
  recipeKeepsPromptPrivate,
  suggestCreationPostTitle,
  suggestProfileHandle,
  suggestRemixPostTitle,
} from '../../ugc-mobile/lib/post-publish-policy/post-publish-policy';

// Most creations have no title of their own (22 of 98 on production,
// 2026-10-25), so both composers suggest one instead of asking for typing.
describe('the title suggested for a post of a creation', () => {
  const suggest = (prompt: string | null, overrides: Partial<Parameters<typeof suggestCreationPostTitle>[0]> = {}) =>
    suggestCreationPostTitle({ prompt, model: 'nano-banana-2', category: 'image', promptPrivate: false, ...overrides });

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

  it('never suggests the prompt while a paid recipe keeps it private', () => {
    expect(suggest('Neon samurai walking through rain', { promptPrivate: true }))
      .toEqual({ title: 'Image recipe', source: 'kind' });
    expect(suggest('Neon samurai walking through rain', { promptPrivate: true, category: 'video', model: 'seedance-2' }).title)
      .toBe('Video recipe');
  });

  // Owner, 2026-10-29: a free recipe hands its prompt to anyone with one tap, so its title
  // may be cut from it; only a paid one, whose prompt is what is sold, keeps it private.
  it('keeps the prompt private for a paid recipe only', () => {
    expect(recipeKeepsPromptPrivate('paid')).toBe(true);
    expect(recipeKeepsPromptPrivate('free')).toBe(false);
    expect(recipeKeepsPromptPrivate('none')).toBe(false);
    expect(recipeKeepsPromptPrivate(null)).toBe(false);
  });

  it('names what was made when the prompt gives no title', () => {
    expect(suggest(null)).toEqual({ title: 'AI image', source: 'kind' });
    expect(suggest('test')).toEqual({ title: 'AI image', source: 'kind' });
    expect(suggest('', { category: 'video', model: 'kling-3.0-video' }).title).toBe('AI video');
    // Motion control creations carry no category, only the model.
    expect(suggest(null, { category: null, model: 'kling-2.6/motion-control' }).title).toBe('Motion transfer');
  });

  // A motion prompt says how to move, not what is shown: "No distortion, the
  // character's movements are consistent with the video."
  it('names a motion transfer by its kind, never by its prompt', () => {
    const motionPrompt = 'No distortion, the character’s movements are consistent with the video.';
    expect(suggest(motionPrompt, { category: 'video', model: 'kling-3.0-motion', creationMode: 'motion' }))
      .toEqual({ title: 'Motion transfer', source: 'kind' });
    expect(suggest(motionPrompt, { category: 'video', model: 'kling-3.0/video', creationMode: 'motion' }).title)
      .toBe('Motion transfer');
    expect(suggest(motionPrompt, { category: 'motion', model: null, promptPrivate: true }).title).toBe('Motion transfer recipe');
  });

  it('only suggests titles the public-post rule takes', () => {
    for (const prompt of ['test test', 'Demo video of a', 'asdf', 'Untitled creation', '!!!', 'Lorem ipsum dolor']) {
      const { title } = suggest(prompt);
      expect(isPlaceholderText(title), `${prompt} → ${title}`).toBe(false);
    }
    expect(suggest('Lorem ipsum dolor')).toEqual({ title: 'AI image', source: 'kind' });
  });

  // The search gates compose a page title of their own for these, as many
  // posts can carry the same one.
  it('lists every kind title for the search gates, lowercased', () => {
    expect(GENERIC_SUGGESTED_TITLES).toEqual(expect.arrayContaining([
      'ai image', 'ai video', 'motion transfer', 'ai audio',
      'image recipe', 'video recipe', 'motion transfer recipe', 'audio recipe',
    ]));
    expect(GENERIC_SUGGESTED_TITLES).toHaveLength(8);
  });
});

// A title cut from the prompt would publish part of a prompt a paid recipe keeps
// private, so putting one on swaps it, and taking it off brings it back.
describe('the title once a paid recipe is put on or taken off', () => {
  const creation = {
    prompt: 'A product still lit like a window display, soft morning light, 85mm',
    model: 'nano-banana-2',
    category: 'image',
  };
  const fromPrompt = 'Product still lit like a window display';

  it('swaps the prompt’s title for the kind title and back', () => {
    expect(followTitleForPromptPrivacy(fromPrompt, creation, false, true)).toBe('Image recipe');
    expect(followTitleForPromptPrivacy('Image recipe', creation, true, false)).toBe(fromPrompt);
  });

  it('keeps anything the creator typed, and changes nothing while the recipe stays as it was', () => {
    expect(followTitleForPromptPrivacy('Window still', creation, false, true)).toBe('Window still');
    expect(followTitleForPromptPrivacy('Window still', creation, true, false)).toBe('Window still');
    expect(followTitleForPromptPrivacy(fromPrompt, creation, true, true)).toBe(fromPrompt);
    expect(followTitleForPromptPrivacy('AI image', creation, false, true)).toBe('AI image');
  });

  it('turns a kind title into the plain one when a prompt gives no title', () => {
    expect(followTitleForPromptPrivacy('Image recipe', { ...creation, prompt: null }, true, false)).toBe('AI image');
  });

  // Free recipes were titled "Image recipe" before 2026-10-29, when any recipe kept the prompt
  // private: taking such a recipe off, or changing it, gives the prompt's title back as before.
  it('gives a free recipe’s kind title back to the prompt when the recipe changes', () => {
    expect(followTitleForPromptPrivacy('Image recipe', creation, false, false)).toBe(fromPrompt);
    expect(followTitleForPromptPrivacy('Image recipe', creation, true, true)).toBe('Image recipe');
  });
});

// A remix's post starts from its original's title, marked as a remix (the mock-up's Result:
// "intense (remix)"), where the creation has no title of its own.
describe('the title suggested for a remix', () => {
  it('marks the original’s title as a remix', () => {
    expect(suggestRemixPostTitle('intense')).toBe('intense (remix)');
    expect(suggestRemixPostTitle('  Kung fu cats  ')).toBe('Kung fu cats (remix)');
  });

  it('cuts a long title at a word so the mark fits in sixty characters', () => {
    const title = suggestRemixPostTitle('A paper boat drifting slowly across a sunlit pond in the early morning light');
    expect(title).toBe('A paper boat drifting slowly across a sunlit pond (remix)');
    expect(title.length).toBeLessThanOrEqual(60);
  });

  it('never ends the cut on a joining word, a comma after it included', () => {
    expect(suggestRemixPostTitle('Cats in a dojo at night with lanterns and, of course, a giant gong'))
      .toBe('Cats in a dojo at night with lanterns (remix)');
  });

  it('suggests none from a placeholder or an empty title, nor a second mark', () => {
    expect(suggestRemixPostTitle('Untitled Creation')).toBe('');
    expect(suggestRemixPostTitle('')).toBe('');
    expect(suggestRemixPostTitle(null)).toBe('');
    expect(suggestRemixPostTitle('intense (remix)')).toBe('intense (remix)');
  });

  it('says where it came from, in the words both composers use', () => {
    expect(describeTitleSuggestion('remix', true)).toBe('Suggested from the original. Edit it if you like.');
    expect(describeTitleSuggestion('remix', false)).toBe('Suggested from the original. Edit it if you like.');
  });
});

// What the server compares a recipe post's title with: the title a suggestion
// cuts from the prompt, however its case or spacing was changed on the way.
describe('whether a title is the opening of a prompt', () => {
  const prompt = 'A product still lit like a window display, soft morning light, 85mm';

  it('knows the cut title, without its case, its spacing or the marks at its edges', () => {
    expect(isTitleFromPrompt('Product still lit like a window display', prompt)).toBe(true);
    expect(isTitleFromPrompt('  product STILL lit like a  window display ', prompt)).toBe(true);
    expect(isTitleFromPrompt('"Product still lit like a window display."', prompt)).toBe(true);
  });

  it('knows nothing else as one: another title, an empty one, or a prompt that gives none', () => {
    expect(isTitleFromPrompt('Window still', prompt)).toBe(false);
    expect(isTitleFromPrompt('Product still lit like a window', prompt)).toBe(false);
    expect(isTitleFromPrompt('', prompt)).toBe(false);
    expect(isTitleFromPrompt('Product still', null)).toBe(false);
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

  // A reserved handle ("admin", "support") would only be refused at save.
  it('passes over a handle the caller cannot use, to the email, then to none', () => {
    const notAdmin = (handle: string) => handle !== 'admin';
    expect(suggestProfileHandle('Admin', 'maya.k@example.com', notAdmin)).toBe('maya-k');
    expect(suggestProfileHandle('Admin', 'admin@example.com', notAdmin)).toBe('');
  });
});
