import { fireEvent, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { NO_VIEWER_STATE } from '@/app/marketplace/marketplace-card-access';
import { MarketplaceRecipeTile } from '@/app/marketplace/MarketplaceRecipeTile';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

// A recipe tile's cover while its picture comes (owner's recording, 2026-11-16: a recipe "Load more"
// brought stayed solid black until its picture came, and every Back painted the tiles dark first).
// The browser end of it is tests/e2e/marketplace-keeps-place.spec.ts; jsdom never loads a picture,
// so every cover here is on its way until a case fires its load.

function recipe(previewUrl: string): MarketplaceResourceListItem {
  const date = '2026-04-25T10:00:00.000Z';
  return {
    id: `bundle-${previewUrl}`,
    postId: 'post-1',
    legacyAssetId: null,
    title: 'Night shift',
    summary: 'A reusable creator prompt.',
    previewText: 'Prompt included.',
    accessMode: 'free',
    priceUsdCents: 0,
    salesCount: 0,
    freeUnlockCount: 0,
    allowRemix: false,
    resourceKinds: ['prompt'],
    lockedPreview: {
      resourceKinds: ['prompt'],
      attachmentPreviews: [],
      itemCounts: { prompt: 1 },
      itemPreviews: [],
      hasPrompt: true,
      hasNotes: false,
      hasWorkflow: false,
      hasRemix: false,
      updatedAt: date,
    },
    createdAt: date,
    updatedAt: date,
    seller: { id: 'creator-1', username: 'creator-1', name: 'Creator 1', avatar: null },
    post: {
      id: 'post-1',
      generationId: null,
      title: 'Night shift',
      category: 'image',
      body: '',
      postFormat: 'media',
      visibility: 'public',
      archivedAt: null,
      tombstoned: false,
      reviewStatus: 'visible',
      sourceKind: 'manual',
      sourceTool: null,
      sourceToolSlug: null,
      // Off the storage CDN, so the cover is a plain picture, as a ready preview is.
      mediaUrl: previewUrl.replace('.preview', ''),
      mediaPreviewUrl: previewUrl,
      mediaRenditionUrl: null,
      mediaKind: 'image',
      saveCount: 0,
      remixCount: 0,
      shareVisitCount: 0,
    },
    priceQuote: { currency: 'USD', amountSubunits: 0, formatted: '$0.00', note: null },
    remixCapability: 'none',
    remixTarget: null,
  };
}

function tile(previewUrl: string) {
  return <MarketplaceRecipeTile asset={recipe(previewUrl)} viewer={NO_VIEWER_STATE} href="/showcase/post-1" />;
}

/** The tile's frame, its cover and the shimmer standing in for it. */
function coverOf(container: HTMLElement) {
  const frame = container.querySelector('a')!.firstElementChild as HTMLElement;
  return {
    frame,
    picture: frame.querySelector('img')!,
    shimmer: frame.querySelector(':scope > span[aria-hidden="true"]'),
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('a recipe tile while its picture comes', () => {
  it('stands on the card surface, not black', () => {
    const { container } = render(tile('https://cdn.example.com/surface.preview.0000aaaa.webp'));

    expect(coverOf(container).frame).toHaveClass('bg-[var(--ui-surface-1)]');
    expect(coverOf(container).frame).not.toHaveClass('bg-black');
  });

  it('waits behind a shimmer when mounted after the page hydrated, then fades its picture in', () => {
    const { container } = render(tile('https://cdn.example.com/later.preview.0000bbbb.webp'));

    expect(coverOf(container).picture).toHaveClass('opacity-0');
    expect(coverOf(container).shimmer).not.toBeNull();

    fireEvent.load(coverOf(container).picture);
    expect(coverOf(container).picture).toHaveClass('opacity-100', 'transition-opacity');
    expect(coverOf(container).shimmer).toBeNull();
  });

  // Review of #835: hidden as the page hydrated, a cover half drawn went blank, and the first
  // screen's waited on it.
  it('shows a cover the server drew as it loads, never hiding it as the page hydrates', () => {
    const ui = tile('https://cdn.example.com/server.preview.0000cccc.webp');
    const container = document.createElement('div');
    container.innerHTML = renderToString(ui);
    document.body.appendChild(container);

    render(ui, { container, hydrate: true });

    expect(coverOf(container).picture.complete).toBe(false);
    expect(coverOf(container).picture).not.toHaveClass('opacity-0');
    expect(coverOf(container).shimmer).toBeNull();
  });

  it('shows a cover drawn before in this document at once, with no wait and no fade', () => {
    const preview = 'https://cdn.example.com/again.preview.0000dddd.webp';
    const first = render(tile(preview));
    fireEvent.load(coverOf(first.container).picture);
    first.unmount();

    // Back to the listing: a new picture of the same address, which the browser already has.
    const { container } = render(tile(preview));
    expect(coverOf(container).picture).not.toHaveClass('opacity-0');
    expect(coverOf(container).picture).not.toHaveClass('transition-opacity');
    expect(coverOf(container).picture).toHaveAttribute('loading', 'eager');
    expect(coverOf(container).shimmer).toBeNull();
  });

  // Where no one can be read yet (the server's HTML, the same for everyone, and the render that
  // hydrates it), a seller's tile draws their words beside everyone else's, and the list's rules
  // show each viewer their own before the first paint (sweep of 2026-11-17).
  it("draws the seller's words beside everyone else's where no one can be read yet", () => {
    const viewer = { viewerUserId: null, unlockedBundleIds: new Set<string>(), ownershipOf: () => 'unread' as const };
    const html = renderToString(
      <MarketplaceRecipeTile asset={recipe('https://cdn.example.com/mark.preview.0000eeee.webp')} viewer={viewer} href="/showcase/post-1" />,
    );
    const container = document.createElement('div');
    container.innerHTML = html;
    const words = (attribute: string) => Array.from(container.querySelectorAll(`[${attribute}="creator-1"]`), (node) => node.textContent);
    expect(words('data-creator-recipe-pitch')).toEqual(['View free recipe', 'Free recipe']);
    expect(words('data-creator-recipe-owner')).toEqual(['View recipe', 'Your recipe']);
  });

  it("draws the viewer's words alone once the page knows whose the recipe is", () => {
    const viewer = { viewerUserId: null, unlockedBundleIds: new Set<string>(), ownershipOf: () => 'owner-checking' as const };
    const { container } = render(
      <MarketplaceRecipeTile asset={recipe('https://cdn.example.com/own.preview.0000ffff.webp')} viewer={viewer} href="/showcase/post-1" />,
    );
    expect(container.querySelector('[data-creator-recipe-pitch], [data-creator-recipe-owner]')).toBeNull();
    expect(container.textContent).toContain('Your recipe');
    expect(container.textContent).toContain('View recipe');
    expect(container.textContent).not.toMatch(/free recipe/i);
    expect(container.querySelector('a')).toHaveAttribute('aria-label', 'View recipe: Night shift');
  });
});
