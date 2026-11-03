import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import publicPostQuality from '../../contracts/public-post-quality-v1.json';
import {
  countTitleCharacters,
  DECISIVE_PLACEHOLDER_WORDS,
  isTitleTooShortForRecipe,
  PLACEHOLDER_FILLER_WORDS,
  PLACEHOLDER_WORDS,
  RECIPE_TITLE_MIN_LENGTH,
  RECIPE_TITLE_TOO_SHORT_HINT,
} from '../../ugc-mobile/lib/post-publish-policy/post-publish-policy';
import {
  assessMarketplaceListingQuality,
  formatBundleAccessLabel,
  getCreatorPublishReadinessError,
  getMarketplaceQualityError,
  getMarketplaceRefusalFields,
  getPublicPostQualityError,
  isDatabaseRecipeTitleRefusal,
  RECIPE_TITLE_TOO_SHORT_CODE,
  RECIPE_TITLE_TOO_SHORT_REFUSAL,
} from '@/lib/marketplace-trust';

type PublicPostQualityMessageKey = keyof typeof publicPostQuality.messages;

// The app checks this rule before its composer says "Ready to publish"
// (ugc-mobile/__tests__/post-new-view-model.test.ts holds it to the same file),
// so the server's answer and the fixture must not drift apart.
describe('the public-post quality rule, held to contracts/public-post-quality-v1.json', () => {
  it.each(publicPostQuality.cases)(
    'answers title "$title", body "$body", media $hasMedia with $expected',
    ({ title, body, hasMedia, expected }) => {
      expect(getPublicPostQualityError({ title, body, hasMedia })).toBe(
        expected === null ? null : publicPostQuality.messages[expected as PublicPostQualityMessageKey],
      );
    },
  );

  it('reads the placeholder and filler words from the shared module the fixture lists', () => {
    expect([...PLACEHOLDER_WORDS]).toEqual(publicPostQuality.placeholderTokens);
    expect([...DECISIVE_PLACEHOLDER_WORDS]).toEqual(publicPostQuality.decisivePlaceholderTokens);
    expect([...PLACEHOLDER_FILLER_WORDS]).toEqual(publicPostQuality.fillerTokens);
  });

  it.each(publicPostQuality.placeholderTokens)('treats "%s" alone, or with filler words, as a placeholder title', (token) => {
    expect(getPublicPostQualityError({ title: token, hasMedia: true }))
      .toBe(publicPostQuality.messages.placeholder_title);
    expect(getPublicPostQualityError({ title: `My ${token} video 2`, hasMedia: true }))
      .toBe(publicPostQuality.messages.placeholder_title);
  });

  const ordinaryPlaceholderTokens = publicPostQuality.placeholderTokens
    .filter((token) => !publicPostQuality.decisivePlaceholderTokens.includes(token));

  it.each(ordinaryPlaceholderTokens)('takes a real title that uses "%s"', (token) => {
    expect(getPublicPostQualityError({ title: `Neon ${token} reel`, hasMedia: true })).toBeNull();
  });

  it.each(publicPostQuality.decisivePlaceholderTokens)('treats "%s" anywhere as a placeholder', (token) => {
    expect(getPublicPostQualityError({ title: `Neon ${token} reel`, hasMedia: true }))
      .toBe(publicPostQuality.messages.placeholder_title);
  });

  it('asks a post without media for at least the fixture\'s minimum of useful text', () => {
    const text = 'Lighting breakdown for portraits';
    expect(getPublicPostQualityError({
      title: 'Portrait lighting',
      body: text.slice(0, publicPostQuality.minTextLength - 1),
      hasMedia: false,
    })).toBe(publicPostQuality.messages.needs_text);
    expect(getPublicPostQualityError({
      title: 'Portrait lighting',
      body: text.slice(0, publicPostQuality.minTextLength),
      hasMedia: false,
    })).toBeNull();
  });
});

const basePost = {
  title: 'Three-scene product hook',
  body: 'A public breakdown showing the before shot, the proof frame, and the final CTA.',
  postFormat: 'text',
  visibility: 'public',
  archivedAt: null,
  reviewStatus: 'visible',
};

const baseSeller = {
  username: 'launchmaker',
  name: 'Launch Maker',
  avatarUrl: 'https://cdn.example.com/avatar.jpg',
};

// Owner, 2026-11-03: the title minimum stays, and is said plainly. The server
// refuses in the words both composers use, with a code they answer with "Post
// without recipe", and each composer says the rule by the title beforehand.
describe('the title a recipe needs', () => {
  const listing = (title: string) => ({
    title,
    summary: 'Use this exact launch prompt to build a reusable product hook.',
    previewText: 'Includes the prompt, post structure, and creator notes.',
    accessMode: 'free' as const,
    resources: {
      promptText: 'Write a direct product hook with one visual proof point and a short CTA.',
      attachments: [],
      allowRemix: false,
    },
    post: basePost,
    seller: baseSeller,
  });
  const words = 'Lantern glow at dusk';

  it('refuses a title one character short of the shared minimum, in plain words, and takes one at it', () => {
    expect(getMarketplaceQualityError(listing(words.slice(0, RECIPE_TITLE_MIN_LENGTH - 1))))
      .toBe(RECIPE_TITLE_TOO_SHORT_REFUSAL);
    expect(getMarketplaceQualityError(listing(words.slice(0, RECIPE_TITLE_MIN_LENGTH)))).toBeNull();
    expect(RECIPE_TITLE_TOO_SHORT_REFUSAL).not.toMatch(/Improve this recipe/);
    expect(RECIPE_TITLE_TOO_SHORT_REFUSAL.startsWith(RECIPE_TITLE_TOO_SHORT_HINT)).toBe(true);
    // The listing checklist keeps naming the rule, from the same number.
    expect(assessMarketplaceListingQuality(listing('Cat')).issues[0]).toEqual({
      code: 'missing_title',
      field: 'title',
      message: `Add a clear listing title with at least ${RECIPE_TITLE_MIN_LENGTH} characters.`,
    });
  });

  it('keeps the other refusals in the listing rule’s words', () => {
    expect(getMarketplaceQualityError({ ...listing(words), previewText: 'test', summary: '' }))
      .toMatch(/^Improve this recipe before publishing: /);
  });

  it('answers the refusal on all three routes with the fields the fixture pins', () => {
    for (const endpoint of ['createPost', 'publishGeneration', 'updatePost'] as const) {
      const pinned = mobileApiContract.endpoints[endpoint].errors.recipeTitleTooShort;
      expect(pinned.status).toBe(400);
      expect({
        error: RECIPE_TITLE_TOO_SHORT_REFUSAL,
        ...getMarketplaceRefusalFields(RECIPE_TITLE_TOO_SHORT_REFUSAL),
      }).toEqual(pinned.response);
    }
    expect(getMarketplaceRefusalFields(RECIPE_TITLE_TOO_SHORT_REFUSAL)).toEqual({
      field: 'title',
      code: RECIPE_TITLE_TOO_SHORT_CODE,
    });
    expect(getMarketplaceRefusalFields('Improve this recipe before publishing: Add a useful preview.')).toEqual({});
  });

  it('says the hint for the recipes and titles the rule refuses, and no other', () => {
    expect(isTitleTooShortForRecipe('Cat', 'free')).toBe(true);
    expect(isTitleTooShortForRecipe('Cat', 'paid')).toBe(true);
    expect(isTitleTooShortForRecipe('  Cat  ', 'free')).toBe(true);
    expect(isTitleTooShortForRecipe('Cat', 'none')).toBe(false);
    expect(isTitleTooShortForRecipe(words.slice(0, RECIPE_TITLE_MIN_LENGTH), 'paid')).toBe(false);
    // An empty title is asked for on its own, and the server lists a post
    // saved without one under "Recipe".
    expect(isTitleTooShortForRecipe('', 'free')).toBe(false);
    expect(isTitleTooShortForRecipe(null, 'free')).toBe(false);
  });

  // #677's re-review: "Cat 🐱" is six UTF-16 units and five characters. Both
  // checks counted six and let it through, and the database, counting
  // characters, refused it with a 500.
  it('counts a title in characters, as the database does, in both checks', () => {
    expect(countTitleCharacters('Cat 🐱')).toBe(5);
    expect('Cat 🐱'.length).toBe(6);
    expect(isTitleTooShortForRecipe('Cat 🐱', 'free')).toBe(true);
    expect(getMarketplaceQualityError(listing('Cat 🐱'))).toBe(RECIPE_TITLE_TOO_SHORT_REFUSAL);
    expect(isTitleTooShortForRecipe('Cats 🐱', 'free')).toBe(false);
    expect(getMarketplaceQualityError(listing('Cats 🐱'))).toBeNull();
  });

  it('knows the database’s refusal of the same rule, and only that one', () => {
    const raised = (message: string) => ({ code: 'P0001', message });
    expect(isDatabaseRecipeTitleRefusal(raised(
      'Improve this unlock before publishing: Add a clear listing title with at least 6 characters.',
    ))).toBe(true);
    expect(isDatabaseRecipeTitleRefusal(raised(
      'Improve this unlock before publishing: Add a useful preview or summary that tells buyers what they will unlock.',
    ))).toBe(false);
    expect(isDatabaseRecipeTitleRefusal(new Error('socket hang up'))).toBe(false);
    expect(isDatabaseRecipeTitleRefusal(null)).toBe(false);
  });

  it('holds the database’s listing rule to the same minimum', () => {
    const migrations = path.resolve(process.cwd(), 'supabase/migrations');
    const definition = /CREATE (?:OR REPLACE )?FUNCTION public\.marketplace_resource_bundle_quality_issue\b/;
    const newest = fs.readdirSync(migrations)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .filter((file) => definition.test(fs.readFileSync(path.join(migrations, file), 'utf8')))
      .at(-1);
    expect(newest).toBeDefined();
    const sql = fs.readFileSync(path.join(migrations, newest!), 'utf8');
    expect(sql).toContain(`IF v_title = '' OR length(v_title) < ${RECIPE_TITLE_MIN_LENGTH} THEN`);
  });
});

describe('marketplace trust helpers', () => {
  it('formats access labels from localized price quotes', () => {
    expect(formatBundleAccessLabel({
      accessMode: 'free',
      priceUsdCents: 0,
      priceQuote: { currency: 'USD', amountSubunits: 0, formatted: '$0.00', note: null },
    })).toBe('Free recipe');

    expect(formatBundleAccessLabel({
      accessMode: 'paid',
      priceUsdCents: 225,
      priceQuote: { currency: 'INR', amountSubunits: 18900, formatted: '₹189', note: 'Charged in INR for buyers in India.' },
    })).toBe('₹189');

    expect(formatBundleAccessLabel({
      accessMode: 'paid',
      priceUsdCents: 200,
      priceQuote: { currency: 'USD', amountSubunits: 200, formatted: '$2.00', note: null },
    })).toBe('$2.00');
  });

  // Below the cash minimum only credits buy a recipe, so its quote (in any
  // currency) is a price no checkout would take.
  it('prices a credits-only recipe in credits, never in its cash quote', () => {
    expect(formatBundleAccessLabel({
      accessMode: 'paid',
      priceUsdCents: 50,
      priceQuote: { currency: 'USD', amountSubunits: 50, formatted: '$0.50', note: null },
    })).toBe('50 credits');

    expect(formatBundleAccessLabel({
      accessMode: 'paid',
      priceUsdCents: 90,
      priceQuote: { currency: 'INR', amountSubunits: 7600, formatted: '₹76', note: 'Charged in INR for buyers in India.' },
    })).toBe('90 credits');
  });

  it('falls back to the USD figure without a quote, and decides free by the credit price', () => {
    expect(formatBundleAccessLabel({ accessMode: 'paid', priceUsdCents: 900 })).toBe('$9.00');
    expect(formatBundleAccessLabel({ accessMode: 'paid', priceUsdCents: 40, priceQuote: null })).toBe('40 credits');
    expect(formatBundleAccessLabel({ accessMode: 'paid', priceUsdCents: 0 })).toBe('Free recipe');
  });

  it('rejects placeholder and test-like listings', () => {
    const assessment = assessMarketplaceListingQuality({
      title: 'test text',
      summary: 'Use this exact launch prompt to build a reusable product hook.',
      previewText: 'Includes the prompt, post structure, and creator notes.',
      accessMode: 'paid',
      priceUsdCents: 500,
      resources: {
        promptText: 'Write a direct product hook with one visual proof point and a short CTA.',
        attachments: [],
        allowRemix: false,
      },
      post: basePost,
      seller: baseSeller,
    });

    expect(assessment.eligible).toBe(false);
    expect(assessment.issues[0]).toMatchObject({
      code: 'placeholder_title',
      field: 'title',
    });
  });

  it('requires a buyer-facing preview or summary', () => {
    const assessment = assessMarketplaceListingQuality({
      title: 'Reusable product hook prompt',
      summary: '',
      previewText: 'test',
      accessMode: 'paid',
      priceUsdCents: 500,
      resources: {
        promptText: 'Write a direct product hook with one visual proof point and a short CTA.',
        attachments: [],
        allowRemix: false,
      },
      post: basePost,
      seller: baseSeller,
    });

    expect(assessment.eligible).toBe(false);
    expect(assessment.issues.some((issue) => issue.code === 'missing_preview')).toBe(true);
  });

  it('requires a creator profile identity', () => {
    const assessment = assessMarketplaceListingQuality({
      title: 'Reusable product hook prompt',
      summary: 'Use this exact launch prompt to build a reusable product hook.',
      previewText: 'Includes the prompt, post structure, and creator notes.',
      accessMode: 'paid',
      priceUsdCents: 500,
      resources: {
        promptText: 'Write a direct product hook with one visual proof point and a short CTA.',
        attachments: [],
        allowRemix: false,
      },
      post: basePost,
      seller: { username: null, name: 'Creator' },
    });

    expect(assessment.eligible).toBe(false);
    expect(assessment.issues.some((issue) => issue.code === 'missing_creator_identity')).toBe(true);
  });

  it.each(['flagged', 'hidden'] as const)(
    'keeps a %s post out of marketplace eligibility',
    (reviewStatus) => {
      const assessment = assessMarketplaceListingQuality({
        ...promptListingInput(),
        resources: {
          promptText: 'Write a direct product hook with one visual proof point and a short CTA.',
          attachments: [],
          allowRemix: false,
        },
        post: { ...basePost, reviewStatus },
      });

      expect(assessment.eligible).toBe(false);
      expect(assessment.issues).toContainEqual(expect.objectContaining({ code: 'post_not_public' }));
    },
  );

  it('uses one public readiness rule everywhere and never requires an avatar', () => {
    expect(getCreatorPublishReadinessError({
      username: 'creator-a1b2c3d4',
      displayName: 'Launch Maker',
      avatarUrl: 'https://cdn.example.com/avatar.jpg',
    })).toMatch(/custom handle/i);

    expect(getCreatorPublishReadinessError({
      username: 'launchmaker',
      displayName: 'Launch Maker',
      avatarUrl: null,
    })).toBeNull();
  });

  it('keeps avatar-less sellers eligible for the marketplace directory', () => {
    const assessment = assessMarketplaceListingQuality({
      ...promptListingInput(),
      resources: {
        promptText: 'Write a direct product hook with one visual proof point and a short CTA.',
        attachments: [],
        allowRemix: false,
      },
      seller: { username: 'launchmaker', name: 'Launch Maker', avatarUrl: null },
    });

    expect(assessment.eligible).toBe(true);
  });

  it('accepts useful prompt, workflow, file, notes, and remix listings', () => {
    const promptListing = assessMarketplaceListingQuality({
      title: 'Reusable product hook prompt',
      summary: 'Use this exact launch prompt to build a reusable product hook.',
      previewText: 'Includes the prompt, post structure, and creator notes.',
      accessMode: 'paid',
      priceUsdCents: 500,
      resources: {
        promptText: 'Write a direct product hook with one visual proof point and a short CTA.',
        attachments: [],
        allowRemix: false,
      },
      post: basePost,
      seller: baseSeller,
    });

    const workflowListing = assessMarketplaceListingQuality({
      ...promptListingInput(),
      resources: {
        workflowShareUrl: 'https://example.com/workflow',
        attachments: [],
        allowRemix: false,
      },
    });

    const fileListing = assessMarketplaceListingQuality({
      ...promptListingInput(),
      resources: {
        attachments: [{ label: 'Launch brief template', kind: 'link', url: 'https://example.com/template' }],
        allowRemix: false,
      },
    });

    const notesListing = assessMarketplaceListingQuality({
      ...promptListingInput(),
      resources: {
        notesMarkdown: 'Use the first sentence for the proof moment and keep the CTA under eight words.',
        attachments: [],
        allowRemix: false,
      },
    });

    const remixListing = assessMarketplaceListingQuality({
      ...promptListingInput(),
      resources: {
        attachments: [],
        allowRemix: true,
      },
    });

    expect(promptListing.eligible).toBe(true);
    expect(workflowListing.eligible).toBe(true);
    expect(fileListing.eligible).toBe(true);
    expect(notesListing.eligible).toBe(true);
    expect(remixListing.eligible).toBe(true);
  });
});

function promptListingInput() {
  return {
    title: 'Reusable product hook prompt',
    summary: 'Use this exact launch prompt to build a reusable product hook.',
    previewText: 'Includes the prompt, post structure, and creator notes.',
    accessMode: 'paid' as const,
    priceUsdCents: 500,
    post: basePost,
    seller: baseSeller,
  };
}
