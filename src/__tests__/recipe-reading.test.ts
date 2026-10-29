import { describe, expect, it } from 'vitest';

import {
  UNLOCKED_RECIPES_PATH,
  buildRecipeTopUpHref,
  describeRecipeCardPreview,
  describeRecipeFile,
  describeRecipeGroup,
  groupRecipeForReading,
  parseGenerationSetupNotes,
  recipeLinkLabel,
  resolvePricingReturnTo,
  shouldShowRecipeItemTitle,
} from '@/app/showcase/recipe-reading';
import {
  formatPostResourceItemCountSummary,
  normalizePostResourceItems,
  normalizePostResourceSections,
} from '@/lib/post-resource-bundles';

/**
 * How an unlocked recipe reads on both clients: the rule in
 * `ugc-mobile/lib/recipe-reading/recipe-reading.ts`, which the web reads
 * through `src/app/showcase/recipe-reading.ts` and the app imports directly
 * (recipe reading review, 2026-10-29; recipe audit B-F16, B-F17, B-F8).
 */
describe('reading an unlocked recipe', () => {
  describe('a saved generation setup', () => {
    it('reads as keys and values, splitting each line at its first colon', () => {
      expect(parseGenerationSetupNotes('Saved generation setup\nModel: Kling 2.5\nAspect ratio: 9:16\nDuration: 5s')).toEqual({
        title: 'Generation setup',
        entries: [
          { key: 'Model', value: 'Kling 2.5' },
          { key: 'Aspect ratio', value: '9:16' },
          { key: 'Duration', value: '5s' },
        ],
      });
    });

    it("never reinterprets a creator's own notes", () => {
      expect(parseGenerationSetupNotes('Use a slow dolly.\nKeep the light warm.')).toBeNull();
      expect(parseGenerationSetupNotes('Saved generation setup\nJust some words')).toBeNull();
      expect(parseGenerationSetupNotes('Saved generation setup')).toBeNull();
      expect(parseGenerationSetupNotes('')).toBeNull();
      expect(parseGenerationSetupNotes(null)).toBeNull();
    });
  });

  it('names a link by what it opens', () => {
    expect(recipeLinkLabel('workflow')).toBe('Open workflow');
    expect(recipeLinkLabel('remix_link')).toBe('Open remix');
    expect(recipeLinkLabel('external_link')).toBe('Open link');
    expect(recipeLinkLabel('note')).toBe('Open link');
  });

  describe('the order', () => {
    // A live creation recipe (2026-10-29): one prompt card from "Include
    // exact prompt", and the creation's three pictures and one clip, which the
    // server adds when it is read. The web filed those under "More from this
    // post"; the app put the clip in its own "Source assets" card.
    it('reads the prompt, then the pictures and the clip it names, in one gallery', () => {
      const sections = normalizePostResourceSections([
        { id: 'creation-prompt', title: 'Exact generation prompt', kind: 'global' },
      ]);
      const items = normalizePostResourceItems([
        { type: 'prompt', role: 'primary', title: 'Exact generation prompt', textContent: 'Change the first person to @ali', sectionId: 'creation-prompt' },
        { type: 'reference_image', role: 'style_reference', title: '@ali', storagePath: 'generation_inputs/u/g/00-reference_image.png', contentType: 'image/png' },
        { type: 'reference_image', role: 'style_reference', title: '@pic', storagePath: 'generation_inputs/u/g/01-reference_image.jpg', contentType: 'image/jpeg' },
        { type: 'reference_image', role: 'style_reference', title: '@third', storagePath: 'generation_inputs/u/g/02-reference_image.jpg', contentType: 'image/jpeg' },
        { type: 'reference_video', role: 'supporting_workflow', title: 'Video reference 1', storagePath: 'generation_inputs/u/g/03-reference_video.mp4', contentType: 'video/mp4' },
      ], { sections });

      const groups = groupRecipeForReading(items, sections);

      expect(groups.map((group) => [group.title, group.kind])).toEqual([
        ['Exact generation prompt', 'prompt'],
        ['References', 'references'],
      ]);
      expect(groups[1].items).toEqual([]);
      expect(groups[1].media.map((item) => item.title)).toEqual(['@ali', '@pic', '@third', 'Video reference 1']);
      expect(groups.map((group) => describeRecipeGroup(group))).toEqual(['', '3 images · 1 video']);
    });

    // An app build from before the server typed a creation's clip as a
    // reference still receives it as a source file: it joins the gallery all
    // the same, because it is a video.
    it('takes a source file that is a picture, clip or sound into the gallery', () => {
      const items = normalizePostResourceItems([
        { type: 'prompt', role: 'primary', title: 'Prompt', textContent: 'A slow dolly.' },
        { type: 'source_file', role: 'supporting_workflow', title: 'Clip', storagePath: 'u/clip.mp4', contentType: 'video/mp4' },
        { type: 'source_file', role: 'other', title: 'Layers', storagePath: 'u/layers.zip', contentType: 'application/zip' },
      ]);

      const groups = groupRecipeForReading(items, []);

      expect(groups.map((group) => group.title)).toEqual(['Prompt', 'References', 'Files']);
      expect(groups[1].media.map((item) => item.title)).toEqual(['Clip']);
      expect(groups[2].items.map((item) => item.title)).toEqual(['Layers']);
    });

    const sections = normalizePostResourceSections([
      { id: 'look', title: 'The look', kind: 'scene' },
      { id: 'prompt', title: 'Prompt or script', kind: 'scene' },
      { id: 'empty', title: 'Nothing here', kind: 'scene' },
    ]);
    const items = normalizePostResourceItems([
      { type: 'reference_image', role: 'style_reference', title: 'Style frame', storagePath: 'u/style.png', contentType: 'image/png', sectionId: 'look' },
      { type: 'prompt', role: 'primary', title: 'Prompt', textContent: 'A slow dolly.', sectionId: 'prompt' },
      // Sectionless: the creation's own references a recipe gains at read time.
      { type: 'reference_image', role: 'style_reference', title: 'Input 1', storagePath: 'u/input.png', contentType: 'image/png' },
      { type: 'settings', role: 'supporting', title: 'Settings', textContent: 'Saved generation setup\nModel: Kling', sectionId: 'look' },
      // A section that no longer exists.
      { type: 'note', role: 'supporting', title: 'Stray note', textContent: 'Hello', sectionId: 'gone' },
      { type: 'external_link', role: 'supporting', title: 'Moodboard', externalUrl: 'https://example.com/board' },
    ]);

    it("keeps the creator's cards in their order, and gathers the rest by kind after them", () => {
      const groups = groupRecipeForReading(items, sections);

      expect(groups.map((group) => group.title)).toEqual(['The look', 'Prompt or script', 'References', 'Notes', 'Links']);
      // Inside a card, its text first and its pictures as a gallery after.
      expect(groups[0].items.map((item) => item.title)).toEqual(['Settings']);
      expect(groups[0].media.map((item) => item.title)).toEqual(['Style frame']);
      expect(groups[1].items.map((item) => item.title)).toEqual(['Prompt']);
      expect(groups[3].items.map((item) => item.title)).toEqual(['Stray note']);
    });

    it('puts the gathered references straight after the first card holding a prompt', () => {
      const promptFirst = normalizePostResourceSections([
        { id: 'prompt', title: 'Hook', kind: 'scene' },
        { id: 'look', title: 'The look', kind: 'scene' },
      ]);
      const groups = groupRecipeForReading(items, promptFirst);

      expect(groups.map((group) => group.title)).toEqual(['Hook', 'References', 'The look', 'Notes', 'Links']);
    });

    it('reads a recipe with no cards in the shared kind order: Prompt, References, Settings, Notes, Workflow, Files, Links', () => {
      const loose = normalizePostResourceItems([
        { type: 'external_link', role: 'supporting', title: 'Moodboard', externalUrl: 'https://example.com/board' },
        { type: 'source_file', role: 'other', title: 'Layers', storagePath: 'u/layers.zip', contentType: 'application/zip' },
        { type: 'workflow', role: 'primary', title: 'Comfy graph', externalUrl: 'https://example.com/workflow' },
        { type: 'note', role: 'supporting', title: 'Notes', textContent: 'Keep the light warm.' },
        { type: 'note', role: 'supporting', title: 'Notes', textContent: 'Saved generation setup\nModel: Kling' },
        { type: 'reference_image', role: 'style_reference', title: 'Input 1', storagePath: 'u/input.png', contentType: 'image/png' },
        { type: 'prompt', role: 'primary', title: 'Prompt', textContent: 'A slow dolly.' },
      ]);

      expect(groupRecipeForReading(loose, []).map((group) => [group.title, group.kind])).toEqual([
        ['Prompt', 'prompt'],
        ['References', 'references'],
        // A saved setup is stored as a note and read as settings.
        ['Generation setup', 'settings'],
        ['Notes', 'notes'],
        ['Workflow', 'workflow'],
        ['Files', 'files'],
        ['Links', 'links'],
      ]);
    });

    it('leaves out a legacy remix-access marker with nothing in it: Remix is said once, by the panel', () => {
      const legacy = normalizePostResourceItems(undefined, {
        promptText: 'A slow dolly.',
        notesMarkdown: 'Keep the light warm.',
        allowRemix: true,
      });

      expect(groupRecipeForReading(legacy, []).map((group) => group.title)).toEqual(['Prompt', 'Notes']);
    });

    it('calls a card left under a form name by what a lone saved setup in it is', () => {
      const setupSections = normalizePostResourceSections([
        { id: 'notes', title: 'Guide or notes', kind: 'scene' },
        { id: 'why', title: 'Why this works', kind: 'scene' },
      ]);
      const setupItems = normalizePostResourceItems([
        { type: 'note', role: 'supporting', title: 'Notes', textContent: 'Saved generation setup\nModel: Kling', sectionId: 'notes' },
        { type: 'note', role: 'supporting', title: 'Notes', textContent: 'Open with tension.', sectionId: 'why' },
      ], { sections: setupSections });

      const groups = groupRecipeForReading(setupItems, setupSections);
      expect(groups.map((group) => group.title)).toEqual(['Generation setup', 'Why this works']);
      // The creator's name for a card is kept, and the line under it says what it is.
      expect(describeRecipeGroup(groups[1])).toBe('Notes');
      expect(describeRecipeGroup(groups[0])).toBe('');
    });
  });

  describe("a group's line", () => {
    it('says the kind only under a card whose name does not, never over a prompt, and counts past one', () => {
      const cardSections = normalizePostResourceSections([
        { id: 'look', title: 'The look', kind: 'scene' },
        { id: 'refs', title: 'Reference media', kind: 'scene' },
        { id: 'hook', title: 'Hook', kind: 'scene' },
        { id: 'kit', title: 'Campaign kit', kind: 'scene' },
      ]);
      const cardItems = normalizePostResourceItems([
        { type: 'reference_image', role: 'style_reference', title: 'A', storagePath: 'u/a.png', contentType: 'image/png', sectionId: 'look' },
        { type: 'reference_image', role: 'style_reference', title: 'B', storagePath: 'u/b.png', contentType: 'image/png', sectionId: 'look' },
        { type: 'reference_image', role: 'style_reference', title: 'C', storagePath: 'u/c.png', contentType: 'image/png', sectionId: 'refs' },
        { type: 'prompt', role: 'primary', title: 'Hook prompt', textContent: 'Open on the before state.', sectionId: 'hook' },
        { type: 'source_file', role: 'other', title: 'Layers', storagePath: 'u/l.zip', contentType: 'application/zip', sectionId: 'kit' },
        { type: 'external_link', role: 'supporting', title: 'Fonts', externalUrl: 'https://example.com/fonts', sectionId: 'kit' },
      ], { sections: cardSections });

      const lines = Object.fromEntries(groupRecipeForReading(cardItems, cardSections).map((group) => [group.title, describeRecipeGroup(group)]));
      expect(lines).toEqual({
        'The look': 'References · 2 images',
        'Reference media': '',
        Hook: '',
        'Campaign kit': 'Files · 2 items',
      });
    });
  });

  it("drops a lone item's title where it only repeats its card", () => {
    expect(shouldShowRecipeItemTitle({ title: 'Prompt or script', itemCount: 1 }, { title: 'Prompt' })).toBe(false);
    expect(shouldShowRecipeItemTitle({ title: 'Prompt or script', itemCount: 1 }, { title: 'Prompt or script' })).toBe(false);
    expect(shouldShowRecipeItemTitle({ title: 'Guide or notes', itemCount: 1 }, { title: 'Notes' })).toBe(false);
    expect(shouldShowRecipeItemTitle({ title: 'Prompt', itemCount: 1 }, { title: 'Prompt or script' })).toBe(false);
    expect(shouldShowRecipeItemTitle({ title: 'Exact generation prompt', itemCount: 1 }, { title: 'Exact generation prompt' })).toBe(false);
    expect(shouldShowRecipeItemTitle({ title: 'Prompt or script', itemCount: 1 }, { title: 'Hook prompt' })).toBe(true);
    expect(shouldShowRecipeItemTitle({ title: 'The look', itemCount: 1 }, { title: 'Prompt' })).toBe(true);
    expect(shouldShowRecipeItemTitle({ title: 'Prompt or script', itemCount: 2 }, { title: 'Prompt' })).toBe(true);
  });

  // "Prompt or script · prompt · 1 item": the type repeated the title, and
  // the count counted to one (B-F16).
  describe("a locked card's line", () => {
    it('leaves out the kind where the title already says it, and a count of one', () => {
      expect(describeRecipeCardPreview({ title: 'Prompt or script', resourceType: 'prompt', itemCount: 1 }))
        .toEqual({ kindLabel: null, countLabel: null });
      expect(describeRecipeCardPreview({ title: 'Exact generation prompt', resourceType: 'prompt', itemCount: 1 }))
        .toEqual({ kindLabel: null, countLabel: null });
      expect(describeRecipeCardPreview({ title: 'Reference media', resourceType: 'reference_image', itemCount: 3 }))
        .toEqual({ kindLabel: null, countLabel: '3 items' });
    });

    it("says the kind under a title of the creator's own, a prompt's too while it is locked", () => {
      expect(describeRecipeCardPreview({ title: 'Hook', resourceType: 'prompt', itemCount: 1 }))
        .toEqual({ kindLabel: 'Prompt', countLabel: null });
      expect(describeRecipeCardPreview({ title: 'Looks', resourceType: 'reference_image', itemCount: 2 }))
        .toEqual({ kindLabel: 'References', countLabel: '2 items' });
    });
  });

  it("names a file's type in a reader's words, never its MIME type", () => {
    expect(describeRecipeFile('application/pdf', 2_202_009)).toBe('PDF · 2.1 MB');
    expect(describeRecipeFile('image/png', 1_258_291)).toBe('PNG image · 1.2 MB');
    expect(describeRecipeFile('image/jpeg', null)).toBe('JPG image');
    expect(describeRecipeFile('video/quicktime', 900)).toBe('MOV video · 900 B');
    expect(describeRecipeFile('audio/mpeg', 4_000)).toBe('MP3 audio · 3.9 KB');
    expect(describeRecipeFile('application/octet-stream', null)).toBe('File');
    expect(describeRecipeFile(null, null)).toBe('');
  });

  it('counts a locked recipe in the order it reads once unlocked', () => {
    expect(formatPostResourceItemCountSummary({
      external_link: 1,
      source_file: 2,
      workflow: 1,
      note: 1,
      settings: 1,
      reference_video: 1,
      reference_image: 3,
      prompt: 1,
    })).toBe('1 prompt, 3 reference images, 1 reference video, settings, 1 note, 1 workflow, 2 files, 1 link');
  });

  describe('the way back from buying credits', () => {
    it('sends the buyer to Pricing with the recipe to come back to', () => {
      expect(buildRecipeTopUpHref('/showcase/post-1?from=home&returnTo=%2F'))
        .toBe(`/pricing?returnTo=${encodeURIComponent('/showcase/post-1?from=home&returnTo=%2F#recipe')}`);
      // A path that already points somewhere on the page points at the recipe instead.
      expect(buildRecipeTopUpHref('/showcase/post-1#comments'))
        .toBe(`/pricing?returnTo=${encodeURIComponent('/showcase/post-1#recipe')}`);
    });

    it('takes back only a path on this site', () => {
      expect(resolvePricingReturnTo('/showcase/post-1#recipe')).toBe('/showcase/post-1#recipe');
      expect(resolvePricingReturnTo('https://evil.example/showcase')).toBeNull();
      expect(resolvePricingReturnTo('//evil.example/showcase')).toBeNull();
      expect(resolvePricingReturnTo('/\\evil.example')).toBeNull();
      expect(resolvePricingReturnTo('javascript:alert(1)')).toBeNull();
      expect(resolvePricingReturnTo('/pricing?returnTo=%2F')).toBeNull();
      expect(resolvePricingReturnTo(['/a', '/b'])).toBeNull();
      expect(resolvePricingReturnTo(undefined)).toBeNull();
    });
  });

  it('keeps the library one path', () => {
    expect(UNLOCKED_RECIPES_PATH).toBe('/creations?view=unlocks');
  });
});
