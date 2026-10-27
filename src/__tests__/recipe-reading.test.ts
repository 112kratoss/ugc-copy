import { describe, expect, it } from 'vitest';

import {
  UNLOCKED_RECIPES_PATH,
  buildRecipeTopUpHref,
  describeRecipeCardPreview,
  getRecipeItemLinkLabel,
  groupRecipeItemsForReading,
  parseGenerationSetupNotes,
  resolvePricingReturnTo,
  shouldShowRecipeItemTitle,
} from '@/app/showcase/recipe-reading';
import {
  normalizePostResourceItems,
  normalizePostResourceSections,
} from '@/lib/post-resource-bundles';

/**
 * How an unlocked recipe reads on the web (recipe audit B-F17, B-F16,
 * B-F8, 2026-10-27), in the app's words where the app already had them
 * (ugc-mobile/lib/post-resource-bundle-view-model.ts).
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
    expect(getRecipeItemLinkLabel('workflow')).toBe('Open workflow');
    expect(getRecipeItemLinkLabel('remix_link')).toBe('Open remix');
    expect(getRecipeItemLinkLabel('external_link')).toBe('Open link');
    expect(getRecipeItemLinkLabel('note')).toBe('Open link');
  });

  describe("the creator's order", () => {
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
    ]);

    it('keeps sections and their items as the creator ordered them, with the rest last', () => {
      const groups = groupRecipeItemsForReading(items, sections);

      expect(groups.map((group) => group.title)).toEqual(['The look', 'Prompt or script', 'More from this post']);
      expect(groups[0].items.map((item) => item.title)).toEqual(['Style frame', 'Settings']);
      expect(groups[1].items.map((item) => item.title)).toEqual(['Prompt']);
      expect(groups[2].items.map((item) => item.title)).toEqual(['Input 1', 'Stray note']);
    });

    it('puts no heading over a recipe that has no sections', () => {
      const groups = groupRecipeItemsForReading(items.map((item) => ({ ...item, sectionId: null })), []);

      expect(groups).toHaveLength(1);
      expect(groups[0].title).toBeNull();
      expect(groups[0].items.map((item) => item.title)).toEqual(['Style frame', 'Prompt', 'Input 1', 'Settings', 'Stray note']);
    });

    it('leaves out a legacy remix-access marker with nothing in it: Remix is said once, by the panel', () => {
      const legacy = normalizePostResourceItems([
        { type: 'prompt', role: 'primary', title: 'Prompt', textContent: 'A slow dolly.' },
        { type: 'remix_access', role: 'supporting', title: 'Remix access' },
      ]);

      expect(groupRecipeItemsForReading(legacy, []).flatMap((group) => group.items.map((item) => item.type))).toEqual(['prompt']);
    });
  });

  it("drops a lone item's title where it only repeats its card", () => {
    expect(shouldShowRecipeItemTitle({ title: 'Prompt or script', itemCount: 1 }, { title: 'Prompt', type: 'prompt' })).toBe(false);
    expect(shouldShowRecipeItemTitle({ title: 'Prompt or script', itemCount: 1 }, { title: 'Prompt or script', type: 'prompt' })).toBe(false);
    expect(shouldShowRecipeItemTitle({ title: 'Guide or notes', itemCount: 1 }, { title: 'Notes', type: 'note' })).toBe(false);
    expect(shouldShowRecipeItemTitle({ title: 'Prompt or script', itemCount: 1 }, { title: 'Hook prompt', type: 'prompt' })).toBe(true);
    expect(shouldShowRecipeItemTitle({ title: 'Prompt or script', itemCount: 2 }, { title: 'Prompt', type: 'prompt' })).toBe(true);
    expect(shouldShowRecipeItemTitle({ title: null, itemCount: 1 }, { title: 'Prompt', type: 'prompt' })).toBe(true);
  });

  // "Prompt or script · prompt · 1 item": the type repeated the title, and
  // the count counted to one (B-F16).
  describe("a locked card's line", () => {
    it('leaves out the type where the title already is the type, and a count of one', () => {
      expect(describeRecipeCardPreview({ title: 'Prompt or script', resourceType: 'prompt', itemCount: 1 }))
        .toEqual({ typeLabel: null, countLabel: null });
      expect(describeRecipeCardPreview({ title: 'Reference media', resourceType: 'reference_image', itemCount: 3 }))
        .toEqual({ typeLabel: null, countLabel: '3 items' });
      expect(describeRecipeCardPreview({ title: 'prompt', resourceType: 'prompt', itemCount: 1 }))
        .toEqual({ typeLabel: null, countLabel: null });
    });

    it('keeps the type under a title of the creator\'s own', () => {
      expect(describeRecipeCardPreview({ title: 'Hook', resourceType: 'prompt', itemCount: 1 }))
        .toEqual({ typeLabel: 'prompt', countLabel: null });
      expect(describeRecipeCardPreview({ title: 'Looks', resourceType: 'reference_image', itemCount: 2 }))
        .toEqual({ typeLabel: 'reference images', countLabel: '2 items' });
    });
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
