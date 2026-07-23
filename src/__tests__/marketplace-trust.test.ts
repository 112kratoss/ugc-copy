import { describe, expect, it } from 'vitest';

import {
  assessMarketplaceListingQuality,
  formatBundleAccessLabel,
  getCreatorPublishReadinessError,
} from '@/lib/marketplace-trust';

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

describe('marketplace trust helpers', () => {
  it('formats access labels from localized price quotes', () => {
    expect(formatBundleAccessLabel({
      accessMode: 'free',
      priceQuote: { currency: 'USD', amountSubunits: 0, formatted: '$0.00', note: null },
    })).toBe('Free recipe');

    expect(formatBundleAccessLabel({
      accessMode: 'paid',
      priceQuote: { currency: 'INR', amountSubunits: 18900, formatted: '₹189', note: 'Charged in INR for buyers in India.' },
    })).toBe('₹189 recipe');

    expect(formatBundleAccessLabel({
      accessMode: 'paid',
      priceQuote: { currency: 'USD', amountSubunits: 200, formatted: '$2.00', note: null },
    })).toBe('$2.00 recipe');
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

  it('uses one readiness rule for public posts and a stronger seller rule for unlocks', () => {
    expect(getCreatorPublishReadinessError({
      username: 'creator-a1b2c3d4',
      displayName: 'Launch Maker',
      avatarUrl: 'https://cdn.example.com/avatar.jpg',
    }, { requiresAvatar: false })).toMatch(/custom handle/i);

    expect(getCreatorPublishReadinessError({
      username: 'launchmaker',
      displayName: 'Launch Maker',
      avatarUrl: null,
    }, { requiresAvatar: false })).toBeNull();

    expect(getCreatorPublishReadinessError({
      username: 'launchmaker',
      displayName: 'Launch Maker',
      avatarUrl: null,
    }, { requiresAvatar: true })).toMatch(/profile photo/i);
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
