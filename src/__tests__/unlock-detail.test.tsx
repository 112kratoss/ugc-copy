import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UnlockDetail from '@/app/unlocks/[postId]/UnlockDetail';

const { panelProps } = vi.hoisted(() => ({ panelProps: vi.fn() }));

vi.mock('@/app/showcase/[id]/PostResourceBundlePanel', () => ({
  default: (props: unknown) => {
    panelProps(props);
    return null;
  },
}));

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const currentResources = {
  promptText: 'Latest prompt',
  notesMarkdown: null,
  workflowShareUrl: null,
  workflowSnapshot: null,
  attachments: [],
  allowRemix: false,
  sections: [],
  items: [],
};

const mediaItems = [
  { id: 'media-1', mediaKey: 'proof-one', url: '/one.jpg', mediaKind: 'image', sortOrder: 0 },
  { id: 'media-2', mediaKey: 'proof-two', url: '/two.jpg', mediaKind: 'image', sortOrder: 1 },
];

const baseDetail = {
  unlockId: 'unlock-1',
  bundleId: 'bundle-1',
  postId: 'post-1',
  title: 'Latest title',
  summary: 'Latest summary',
  previewText: 'Latest preview',
  accessMode: 'paid',
  priceUsdCents: 900,
  purchasePriceUsdCents: 500,
  paidWith: 'credits',
  paidAmountSubunits: 500,
  paidCurrency: null,
  salesCount: null,
  freeUnlockCount: null,
  purchasedAt: '2026-07-02T00:00:00.000Z',
  creatorDisplayName: 'Creator',
  creatorUserId: 'creator-1',
  resourceKinds: ['prompt'],
  currentResources,
  purchasedRevision: {
    revisionId: 'revision-1',
    revisionNumber: 2,
    createdAt: '2026-07-01T00:00:00.000Z',
    title: 'Purchased title',
    summary: 'Purchased summary',
    previewText: 'Purchased preview',
    accessMode: 'free',
    priceUsdCents: 0,
    mediaItems: mediaItems.slice(0, 1),
    resources: { ...currentResources, promptText: 'Purchased prompt' },
  },
  hasNewerRevision: true,
  detached: false,
  retired: false,
  tombstoned: false,
  postVisibility: 'private',
  isNsfw: false,
  postReachable: false,
  post: null,
  mediaItems,
};

function renderDetail(overrides: Record<string, unknown> = {}) {
  render(<UnlockDetail detail={{ ...baseDetail, ...overrides } as never} />);
}

describe('UnlockDetail', () => {
  beforeEach(() => {
    panelProps.mockClear();
  });

  it('forwards proof media, unknown sales, and complete revision metadata', () => {
    renderDetail();

    expect(panelProps).toHaveBeenCalledWith(expect.objectContaining({
      mediaItems,
      salesCount: null,
      freeUnlockCount: null,
      purchasedRevision: expect.objectContaining({
        title: 'Purchased title',
        summary: 'Purchased summary',
        previewText: 'Purchased preview',
        accessMode: 'free',
        priceUsdCents: 0,
        mediaItems: mediaItems.slice(0, 1),
      }),
    }));
  });

  // A free recipe's "N opened" counts free unlocks, which stopped counting as
  // sales on 2026-10-17 (decision 6); the panel picks the one its mode needs.
  it('forwards both unlock counts', () => {
    renderDetail({ accessMode: 'free', salesCount: 1, freeUnlockCount: 5 });

    expect(panelProps).toHaveBeenCalledWith(expect.objectContaining({ salesCount: 1, freeUnlockCount: 5 }));
  });

  // The panel draws its price line only while a recipe is locked, so the page
  // says what was paid itself, in what it was paid with.
  it.each([
    ['a rupee checkout', { paidWith: 'cash', paidAmountSubunits: 75000, paidCurrency: 'INR' }, '₹750 paid'],
    ['a dollar checkout', { paidWith: 'cash', paidAmountSubunits: 900, paidCurrency: 'USD' }, '$9.00 paid'],
    ['a credit unlock', { paidWith: 'credits', paidAmountSubunits: 900, paidCurrency: null }, '900 credits'],
    ['a free unlock', { paidWith: 'free', paidAmountSubunits: null, paidCurrency: null }, 'Free'],
  ])('says what %s cost', (_name, payment, label) => {
    renderDetail(payment);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText('What you paid:')).toBeInTheDocument();
  });

  it('gives one neutral reason when the post is out of reach, whatever kept it there', () => {
    renderDetail({ postReachable: false, postVisibility: 'public' });

    expect(screen.getByText("This post isn't available to you. Your recipe stays here.")).toBeInTheDocument();
    // A block used to read as this, which was not true of a public post.
    expect(screen.queryByText(/no longer public/)).toBeNull();
  });

  it.each([
    ['a deleted account', { detached: true, postId: null, bundleId: null }, /The creator deleted their account/],
    ['a removed post', { tombstoned: true }, /The creator removed this post/],
    ['a retired unlock', { retired: true }, /This recipe is no longer sold/],
  ])('keeps the specific reason for %s', (_name, state, reason) => {
    renderDetail(state);

    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByText(/isn't available to you/)).toBeNull();
  });

  it('leads back to the library by its name', () => {
    renderDetail({});

    // `next/link` is a bare fragment in this file: the words are what is asked.
    expect(screen.getByText('Unlocked recipes')).toBeInTheDocument();
    expect(screen.queryByText(/your unlocks/i)).toBeNull();
  });

  it('explains nothing when the post is reachable and the page holds it only for its mature label', () => {
    renderDetail({ postReachable: true, isNsfw: true, postVisibility: 'public' });

    expect(screen.queryByText(/stays here|retained here|kept here|stays available here/)).toBeNull();
    expect(panelProps).toHaveBeenCalled();
  });

  // The page draws no media of its own: every still and preview is the panel's.
  it.each([
    ['a mature post', true],
    ['any other post', false],
  ])('has the panel cover its media for %s', (_name, isNsfw) => {
    renderDetail({ isNsfw, postReachable: true, postVisibility: 'public' });

    expect(panelProps).toHaveBeenCalledWith(expect.objectContaining({ coverMedia: isNsfw }));
  });
});
