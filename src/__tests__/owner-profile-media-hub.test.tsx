import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OwnerProfileMediaHub from '@/app/profile/OwnerProfileMediaHub';
import type { ShowcaseFeedItem } from '@/lib/showcase';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => '/profile',
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock('next/dynamic', () => ({
  default: () => function MockReel({
    isOpen,
    items,
    selectedItemId,
    buildDetailPath,
  }: {
    isOpen: boolean;
    items: ShowcaseFeedItem[];
    selectedItemId: string | null;
    buildDetailPath: (id: string, section?: string) => string;
  }) {
    const item = items.find((candidate) => candidate.id === selectedItemId);
    return isOpen && item ? (
      <div role="dialog" aria-label={`${item.title} Showcase reel`}>
        <span>{item.title}</span>
        <a href={buildDetailPath(item.id, 'resources')}>Post details</a>
      </div>
    ) : null;
  },
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: { access_token: 'profile-token', user: { id: 'owner-1' } },
    user: { id: 'owner-1' },
  }),
}));

vi.mock('@/app/components/HoverVideo', () => ({
  HoverVideo: ({ src, poster }: { src: string; poster?: string | null }) => (
    <video data-testid="profile-video" data-src={src} poster={poster ?? undefined} />
  ),
}));

vi.mock('@/app/components/OptimizedPreviewImage', () => ({
  OptimizedPreviewImage: ({ previewSrc, alt }: { previewSrc: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={previewSrc} alt={alt} />
  ),
}));

vi.mock('@/app/components/MediaDetailsPreviewModal', () => ({
  default: ({ isOpen, title, prompt }: { isOpen: boolean; title: string; prompt?: string }) => isOpen ? (
    <div role="dialog" aria-label={`${title} creation preview`}>
      <span>{title}</span>
      {prompt ? <span>{prompt}</span> : null}
    </div>
  ) : null,
}));

function response(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: async () => body } as Response);
}

const publicPost = {
  id: 'post-public',
  generationId: 'gen-public',
  visibility: 'public',
  archivedAt: null,
  mediaUrl: 'https://example.com/public.jpg',
  mediaKind: 'image',
  mediaItems: [],
  title: 'Public post',
  description: 'Public description',
  prompt: '',
  body: 'Public story',
  category: 'image',
  postFormat: 'media',
  sourceKind: 'magicbooklet',
  sourceTool: 'Image Studio',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
  publicPath: '/showcase/post-public',
  ownerPath: '/post/post-public/edit',
  resourcePath: '/showcase/post-public#recipe',
  canShare: true,
  bundle: {
    id: 'bundle-public',
    accessMode: 'paid',
    status: 'published',
    priceUsdCents: 900,
    resourceKinds: ['prompt'],
  },
};

const privatePost = {
  ...publicPost,
  id: 'post-private',
  generationId: null,
  visibility: 'private',
  mediaUrl: null,
  mediaKind: null,
  title: 'Private draft',
  publicPath: null,
  ownerPath: '/post/post-private/edit',
  resourcePath: null,
  canShare: false,
  bundle: null,
};

const savedPost: ShowcaseFeedItem = {
  id: 'saved-post',
  generationId: 'saved-generation',
  mediaUrl: 'https://example.com/saved.jpg',
  mediaKind: 'image',
  model: 'image-model',
  title: 'Saved inspiration',
  prompt: '',
  body: 'Saved story',
  category: 'image',
  postFormat: 'media',
  saveCount: 4,
  remixCount: 1,
  commentCount: 0,
  createdAt: '2026-06-30T00:00:00.000Z',
  savedAt: '2026-07-03T00:00:00.000Z',
  creator: { id: 'creator-2', username: 'creator-two', name: 'Creator Two', avatar: null },
  isSaved: true,
  sourceKind: 'magicbooklet',
  sourceTool: null,
  asset: null,
  canRemix: true,
};

describe('OwnerProfileMediaHub', () => {
  beforeEach(() => {
    pushMock.mockReset();
    window.history.replaceState(null, '', '/profile');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/posts?')) {
        return response({ posts: [publicPost, privatePost], pageInfo: { hasMore: false, nextOffset: null } });
      }
      if (url.startsWith('/api/showcase/saved-media?')) {
        return response({ items: [savedPost], pageInfo: { hasMore: false, nextOffset: null } });
      }
      if (url.includes('/api/generations?includeArchived=false&detail=summary')) {
        return response({
          generations: [{
            id: 'raw-generation',
            output_url: 'https://example.com/raw.jpg',
            preview_url: 'https://example.com/raw-preview.jpg',
            status: 'completed',
            created_at: '2026-07-04T00:00:00.000Z',
            duration: 8,
            model: 'image-model',
            category: 'image',
            title: 'Raw frame',
            linked_post_id: null,
          }, {
            id: 'failed-generation',
            output_url: null,
            preview_url: null,
            status: 'failed',
            created_at: '2026-07-05T00:00:00.000Z',
            model: 'video-model',
            category: 'video',
            title: 'Failed clip',
            linked_post_id: null,
          }],
          pagination: { hasMore: false, nextCursor: null },
        });
      }
      if (url.includes('/api/generations?includeArchived=false&id=raw-generation')) {
        return response({
          generations: [{
            id: 'raw-generation',
            output_url: 'https://example.com/raw.jpg',
            status: 'completed',
            created_at: '2026-07-04T00:00:00.000Z',
            duration: 8,
            model: 'image-model',
            category: 'image',
            title: 'Raw frame',
            prompt: 'Owner-only creation prompt',
            input_media: [],
          }],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  it('separates public post discovery from private post management', async () => {
    render(<OwnerProfileMediaHub creator={{ id: 'owner-1', username: 'owner', name: 'Owner', avatar: null }} />);

    fireEvent.click(await screen.findByRole('button', { name: /open public post/i }));

    const reel = screen.getByRole('dialog', { name: /public post showcase reel/i });
    expect(reel).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /post details/i })).toHaveAttribute(
      'href',
      '/showcase/post-public?from=profile&returnTo=%2Fprofile%3Ftab%3Dposts#recipe'
    );
    expect(screen.getByRole('link', { name: /private draft/i })).toHaveAttribute('href', '/post/post-private/edit');
    expect(window.location.search).toContain('post=post-public');
  });

  it('keeps raw creations in a focused preview instead of the Showcase reel', async () => {
    render(<OwnerProfileMediaHub creator={{ id: 'owner-1', username: 'owner', name: 'Owner', avatar: null }} />);

    await screen.findByRole('button', { name: /open public post/i });
    fireEvent.click(screen.getByRole('tab', { name: /creations 1/i }));
    fireEvent.click(screen.getByRole('button', { name: /open raw frame/i }));

    expect(screen.getByRole('dialog', { name: /raw frame creation preview/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /showcase reel/i })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Owner-only creation prompt')).toBeInTheDocument());
  });

  it('keeps failed runs out of the grid but reachable, and never as a dead control', async () => {
    render(<OwnerProfileMediaHub creator={{ id: 'owner-1', username: 'owner', name: 'Owner', avatar: null }} />);

    await screen.findByRole('button', { name: /open public post/i });
    fireEvent.click(screen.getByRole('tab', { name: /creations 1/i }));

    expect(screen.getByRole('button', { name: /open raw frame/i })).toBeInTheDocument();
    expect(screen.queryByText('Failed clip')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /failed runs/i }));

    expect(screen.getByText('Failed clip')).toBeInTheDocument();
    expect(screen.queryByText('Raw frame')).not.toBeInTheDocument();
    // No media to open, so the card is a record rather than a control that
    // does nothing when pressed.
    expect(screen.queryByRole('button', { name: /open failed clip/i })).not.toBeInTheDocument();
  });
});
