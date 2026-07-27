import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreatorContentTabs } from '@/app/creators/[username]/CreatorContentTabs';
import type { CreatorProfilePageData } from '@/lib/creator-profile';

const routerPush = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/creators/creator-name',
  useRouter: () => ({ push: routerPush }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({ session: null, user: null }),
}));

vi.mock('@/app/showcase/ShowcaseMediaCarousel', () => ({
  default: ({ onOpen, title }: { onOpen?: (index: number) => void; title: string }) => (
    <button type="button" onClick={() => onOpen?.(0)}>{title}</button>
  ),
}));

vi.mock('@/app/showcase/ShowcaseReelViewer', () => ({
  default: ({ isOpen, selectedItemId }: { isOpen: boolean; selectedItemId: string | null }) => isOpen ? (
    <div role="dialog" aria-label="Creator immersive viewer">{selectedItemId}</div>
  ) : null,
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: { div: ({ children }: { children: ReactNode }) => <div>{children}</div> },
}));

const items: CreatorProfilePageData['items'] = [
  {
    id: 'item-1',
    mediaUrl: 'https://example.com/creation.jpg',
    mediaKind: 'image',
    mediaItems: [{
      id: 'media-1',
      url: 'https://example.com/creation.jpg',
      previewUrl: 'https://example.com/creation-preview.webp',
      mediaKind: 'image',
      contentType: 'image/jpeg',
      originalName: 'creation.jpg',
      width: 1080,
      height: 1350,
      durationSeconds: null,
      sortOrder: 0,
    }],
    model: 'nano-banana-2',
    title: 'Campaign Frame',
    prompt: 'A creator holds the product near a bright window.',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 12,
    remixCount: 4,
    commentCount: 0,
    createdAt: '2026-03-27T10:00:00.000Z',
    creator: { id: 'creator-1', username: 'creator-name', name: 'Creator Name', avatar: null },
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: 'gen-1',
    asset: null,
    canRemix: true,
  },
  {
    id: 'item-2',
    mediaUrl: null,
    mediaKind: null,
    model: 'external',
    title: 'Workflow Breakdown',
    prompt: '',
    body: 'A concise workflow breakdown.',
    category: 'text',
    postFormat: 'text',
    saveCount: 3,
    remixCount: 1,
    commentCount: 0,
    createdAt: '2026-03-28T10:00:00.000Z',
    creator: { id: 'creator-1', username: 'creator-name', name: 'Creator Name', avatar: null },
    sourceKind: 'external',
    sourceTool: 'Runway',
    sourceToolSlug: 'runway',
    generationId: null,
    asset: {
      id: 'bundle-1',
      postId: 'item-2',
      title: 'Workflow Breakdown Unlock',
      accessMode: 'paid',
      priceUsdCents: 900,
      previewText: 'Prompt and workflow included.',
      allowRemix: false,
      salesCount: 2,
      resourceKinds: ['prompt', 'workflow'],
    },
    canRemix: false,
  },
];

const initialData: CreatorProfilePageData = {
  profile: {
    id: 'creator-1',
    username: 'creator-name',
    displayName: 'Creator Name',
    bio: 'Creator bio',
    avatarUrl: null,
    coverUrl: null,
    websiteUrl: null,
    twitterHandle: null,
    instagramHandle: null,
    tiktokHandle: null,
    location: null,
  },
  stats: {
    publicCreations: 8,
    totalSaves: 15,
    totalRemixes: 5,
    unlocks: 3,
    totalUnlockSales: 2,
    toolsUsed: [{ slug: 'runway', label: 'Runway', count: 4 }],
  },
  items,
  pageInfo: { hasMore: false, limit: 24, offset: 0, nextOffset: null, nextLimit: null },
};

describe('CreatorContentTabs', () => {
  beforeEach(() => {
    routerPush.mockReset();
    window.history.replaceState(null, '', '/creators/creator-name');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses global counts and opens a post in the immersive viewer', async () => {
    render(<CreatorContentTabs initialData={initialData} profilePath="/creators/creator-name" />);

    expect(screen.getByRole('tab', { name: /posts 8/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /recipes 3/i })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /campaign frame/i })[0]);

    expect(await screen.findByRole('dialog', { name: /creator immersive viewer/i })).toHaveTextContent('item-1');
    expect(window.location.search).toContain('post=item-1');
  });

  it('filters recipes and makes source tools actionable', () => {
    render(<CreatorContentTabs initialData={initialData} profilePath="/creators/creator-name" />);

    fireEvent.click(screen.getByRole('tab', { name: /recipes 3/i }));
    expect(screen.getByText('Workflow Breakdown')).toBeInTheDocument();
    expect(screen.queryByText('Campaign Frame')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /tools 1/i }));
    expect(screen.getByRole('link', { name: /runway/i })).toHaveAttribute('href', '/showcase?tool=runway');
  });

  it('loads and appends the next stable creator page when automatic observation is unavailable', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const nextItem = {
      ...items[0],
      id: 'item-3',
      title: 'Second Page Frame',
      mediaItems: items[0].mediaItems?.map((media) => ({ ...media, id: 'media-3' })),
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...initialData,
        items: [nextItem],
        pageInfo: { hasMore: false, limit: 24, offset: 24, nextOffset: null, nextLimit: null },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <CreatorContentTabs
        initialData={{
          ...initialData,
          pageInfo: { hasMore: true, limit: 24, offset: 0, nextOffset: 24, nextLimit: 48 },
        }}
        profilePath="/creators/creator-name"
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Load more posts' }));

    expect((await screen.findAllByText('Second Page Frame')).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith('/api/creators/creator-name?limit=24&offset=24', undefined);
  });
});
