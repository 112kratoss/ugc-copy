import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreatorSearchResult } from '@/components/search/CreatorSearchResult';
import { SearchPostCard } from '@/components/search/SearchPostWall';
import type { ShowcaseFeedItem } from '@/lib/showcase';

// Cards and secondary links that open a whole post or creator page prefetched that page as they
// came into view (speed loop, 2026-11-20, owner's Chrome): Studio fetched each creation's post
// page and the creator's own page on every visit (8–11 × 37 KB plus 47 KB, about 2.8 MB of page
// data decoded), the profile hub the creator page (47 KB), and a page of search results each
// post it showed (up to 24 × 37 KB). The card grids' own rule is that nothing is fetched for a
// card scrolled past, so these prefetch on intent now (`IntentLink`), as a post page's creator
// link does (#886): for a resting mouse pointer or the keyboard's focus, never as they paint.

const router = vi.hoisted(() => ({ prefetch: vi.fn(), push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }));
const linkProps = vi.hoisted(() => [] as Array<{ href: unknown; prefetch: unknown }>);

vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

vi.mock('next/link', () => ({
  default: ({ href, prefetch, children, ...rest }: { href: string; prefetch?: boolean; children?: ReactNode }) => {
    linkProps.push({ href, prefetch });
    return <a href={href} {...rest}>{children}</a>;
  },
}));

beforeEach(() => {
  router.prefetch.mockClear();
  linkProps.length = 0;
});

afterEach(() => {
  cleanup();
});

function item(): ShowcaseFeedItem {
  return {
    id: 'post-1',
    title: 'Mahabali',
    body: '',
    prompt: '',
    model: 'nano-banana-2',
    sourceTool: null,
    category: 'image',
    postFormat: 'media',
    mediaKind: 'image',
    mediaUrl: 'https://cdn.example.test/a.png',
    mediaItems: [{
      id: 'm1', url: 'https://cdn.example.test/a.png', previewUrl: 'https://cdn.example.test/a-720.webp', mediaKind: 'image',
      contentType: 'image/png', originalName: null, width: 900, height: 1600, durationSeconds: null, sortOrder: 0,
    }],
    saveCount: 1,
    remixCount: 0,
    commentCount: 4,
    createdAt: '2026-11-12T10:00:00.000Z',
    creator: { id: 'u1', username: 'batman', name: 'Sassy23b', avatar: null },
    sourceKind: 'magicbooklet',
    generationId: 'g1',
    asset: null,
    canRemix: false,
  } as ShowcaseFeedItem;
}

describe("a search result's post card", () => {
  it('fetches nothing as it paints, and prefetches its post for a resting mouse pointer', () => {
    render(<SearchPostCard item={item()} returnTo="/search?q=nano" />);
    const link = screen.getByRole('link');
    const href = link.getAttribute('href');
    expect(href).toContain('/showcase/post-1');

    expect(linkProps).toEqual([{ href, prefetch: false }]);
    expect(router.prefetch).not.toHaveBeenCalled();

    fireEvent.pointerEnter(link, { pointerType: 'touch' });
    expect(router.prefetch).not.toHaveBeenCalled();

    fireEvent.pointerEnter(link, { pointerType: 'mouse' });
    expect(router.prefetch).toHaveBeenCalledWith(href);
  });
});

describe("a search result's creator row", () => {
  it('fetches nothing as it paints, and prefetches the profile for a resting mouse pointer', () => {
    render(
      <CreatorSearchResult
        creator={{ id: 'c1', username: 'mira', displayName: 'Mira', isFollowing: false, avatarUrl: null, publicPostCount: 3 }}
      />,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/creators/mira');
    // Still counted when opened.
    expect(link).toHaveAttribute('data-search-result', 'creator');
    expect(linkProps).toEqual([{ href: '/creators/mira', prefetch: false }]);

    fireEvent.pointerEnter(link, { pointerType: 'mouse' });
    expect(router.prefetch).toHaveBeenCalledWith('/creators/mira');
  });
});

// The other links sit in components too large to draw here without most of the app around them;
// what is pinned is that each is drawn by `IntentLink`, and that no plain `<Link>` draws it again.
describe('the other cards and secondary links that open a whole page', () => {
  const pinned: Array<{ file: string; why: string; href: RegExp }> = [
    { file: 'src/app/search/SearchClient.tsx', why: "a recipe result's card", href: /href=\{buildShowcaseDetailPath\(recipe\.postId,/ },
    { file: 'src/app/creations/page.tsx', why: "Studio's View portfolio", href: /href=\{publicProfileUsername \? `\/creators\/\$\{publicProfileUsername\}` : '\/profile'\}/ },
    { file: 'src/app/creations/page.tsx', why: "a Studio creation's post", href: /href=\{linkedPostHref\}/ },
    { file: 'src/app/creations/page.tsx', why: "a Studio post's View live", href: /href=\{buildStudioDetailPath\(post\.id\)\}/ },
    { file: 'src/app/profile/OwnerProfileMediaHub.tsx', why: "the profile hub's View public", href: /href=\{publicProfilePath\}/ },
    { file: 'src/components/templates/TemplateDetailClient.tsx', why: "a template's creator", href: /href=\{`\/creators\/\$\{encodeURIComponent\(creatorUsername\)\}`\}/ },
    { file: 'src/components/CreatorPublish.tsx', why: "a remix's original creator", href: /href=\{profileHref\}/ },
  ];

  it.each(pinned)('draws $why with IntentLink', ({ file, href }) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const opening = new RegExp(`<(IntentLink|Link)\\s+${href.source}`, 'g');
    const tags = [...source.matchAll(opening)].map((match) => match[1]);
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.every((tag) => tag === 'IntentLink')).toBe(true);
  });
});
