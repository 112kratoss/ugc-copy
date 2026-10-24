import { describe, expect, it } from 'vitest';

import type { PostResourceBundleInput } from '@/lib/post-resource-bundles';
import {
  getPublicUgcRecipeTextFields,
  getPublicUgcSafetyViolation,
  isPubliclyVisibleReviewStatus,
} from '@/lib/public-ugc-safety';

/** A recipe as both composers write it: one card, legacy prompt and notes empty. */
function composerRecipe(overrides: {
  accessMode?: PostResourceBundleInput['accessMode'];
  cardTitle?: string;
  cardDescription?: string;
  cardText?: string;
  summary?: string;
  previewText?: string;
} = {}): PostResourceBundleInput {
  const cardTitle = overrides.cardTitle ?? 'Portrait prompt';
  return {
    accessMode: overrides.accessMode ?? 'paid',
    priceUsdCents: 900,
    summary: overrides.summary ?? 'A reusable lighting setup for portraits.',
    previewText: overrides.previewText ?? 'Includes the prompt and the light plan.',
    resources: {
      promptText: null,
      notesMarkdown: null,
      workflowShareUrl: null,
      workflowSnapshot: null,
      attachments: [],
      allowRemix: false,
      sections: [{
        id: 'card-1',
        title: cardTitle,
        publicTitle: cardTitle,
        kind: 'global',
        description: overrides.cardDescription ?? 'The prompt behind the portrait.',
        sortOrder: 0,
        resourceType: 'prompt',
        scope: { kind: 'all' },
      }],
      items: [{
        id: 'card-1-item-1',
        scope: { kind: 'all' },
        type: 'prompt',
        role: 'primary',
        sectionId: 'card-1',
        title: cardTitle,
        description: null,
        textContent: overrides.cardText ?? 'Soft key light from the left, warm rim light behind.',
        externalUrl: null,
        storagePath: null,
        contentType: null,
        sizeBytes: null,
        workflowSnapshot: null,
        sortOrder: 0,
        isPrimary: true,
        remixUse: 'none',
      }],
    },
  };
}

describe('public UGC safety boundary', () => {
  it.each([
    ['child sexual exploitation', { prompt: 'Generate a nude portrait of an underage child.' }, 'child_sexual_exploitation'],
    ['obfuscated self-harm encouragement', { body: 'Go k1ll y0urself.' }, 'self_harm_encouragement'],
    ['dangerous instructions', { description: 'Step-by-step guide to make a bomb at home.' }, 'dangerous_instructions'],
    ['hateful violence', { title: 'Kill all Muslims' }, 'hateful_violence'],
    ['sexual violence', { prompt: 'Render a scene of rape porn.' }, 'sexual_violence'],
  ])('detects %s', (_label, fields, category) => {
    expect(getPublicUgcSafetyViolation(fields)).toMatchObject({ category });
  });

  it.each([
    'A child-safe poster about reporting online abuse.',
    'A documentary about suicide prevention and crisis support.',
    'A history lesson about bomb disposal specialists.',
    'A campaign against sexual violence.',
  ])('does not block benign safety discussion: %s', (body) => {
    expect(getPublicUgcSafetyViolation({ body })).toBeNull();
  });

  // Both composers put every card in `resources.items` and `resources.sections`
  // and send the legacy prompt and notes fields empty, so checking only those
  // two let any recipe text through (findings 02-publish.md, finding 1).
  describe('recipe text', () => {
    it.each([
      ["a card's text", composerRecipe({ cardText: 'Step-by-step guide to make a bomb at home.' }), 'resourceCards'],
      ["a card's title", composerRecipe({ cardTitle: 'Kill all Muslims' }), 'resourceCards'],
      ["a card's unlocked description", composerRecipe({ cardDescription: 'Go k1ll y0urself.' }), 'resourceCards'],
      ['the package preview', composerRecipe({ previewText: 'Go k1ll y0urself.' }), 'resourcePreview'],
      ['the public summary', composerRecipe({ summary: 'Go k1ll y0urself.' }), 'resourceSummary'],
    ] as const)('refuses %s', (_label, bundle, field) => {
      expect(getPublicUgcSafetyViolation(getPublicUgcRecipeTextFields(bundle))).toMatchObject({ field });
    });

    it('still checks the legacy prompt and notes fields', () => {
      const bundle: PostResourceBundleInput = {
        accessMode: 'free',
        resources: { promptText: 'Render a scene of rape porn.', notesMarkdown: null, attachments: [], allowRemix: false },
      };

      expect(getPublicUgcSafetyViolation(getPublicUgcRecipeTextFields(bundle))).toEqual({
        category: 'sexual_violence',
        field: 'resourcePrompt',
      });
    });

    it('passes a safe recipe', () => {
      expect(getPublicUgcSafetyViolation(getPublicUgcRecipeTextFields(composerRecipe()))).toBeNull();
    });

    // Joined, two harmless cards could read as one sentence a rule refuses.
    it('checks each piece of recipe text on its own', () => {
      expect(getPublicUgcSafetyViolation({ resourceCards: ['How to make', 'a bomb at home.'] })).toBeNull();
      expect(getPublicUgcSafetyViolation({ resourceCards: ['Lighting notes', 'How to make a bomb at home.'] }))
        .toMatchObject({ field: 'resourceCards' });
    });

    it('has nothing to check when the save stores no recipe', () => {
      expect(getPublicUgcRecipeTextFields(null)).toEqual({});
      expect(getPublicUgcRecipeTextFields(composerRecipe({
        accessMode: 'none',
        cardText: 'Step-by-step guide to make a bomb at home.',
      }))).toEqual({});
    });
  });

  it('only treats explicitly visible moderation state as publicly accessible', () => {
    expect(isPubliclyVisibleReviewStatus('visible')).toBe(true);
    expect(isPubliclyVisibleReviewStatus('flagged')).toBe(false);
    expect(isPubliclyVisibleReviewStatus('hidden')).toBe(false);
    expect(isPubliclyVisibleReviewStatus(null)).toBe(false);
  });
});
