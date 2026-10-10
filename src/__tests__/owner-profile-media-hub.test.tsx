import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OwnerProfileMediaHub from '@/app/profile/OwnerProfileMediaHub';
import { readFeedbackSnapshot, resetFeedbackState } from '@/components/feedback-state';
import type { ShowcaseFeedItem } from '@/lib/showcase';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => '/profile',
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

// Stands in for the reel: names the open post, and offers a button for each
// menu handler the page gives it.
type ReelHandler = (item: ShowcaseFeedItem) => void | Promise<void>;
vi.mock('next/dynamic', () => ({
  default: () => function MockReel({
    isOpen,
    items,
    selectedItemId,
    buildDetailPath,
    onFeedback,
    onReportContent,
    onReportUser,
    onBlockUser,
    originLabel,
  }: {
    isOpen: boolean;
    items: ShowcaseFeedItem[];
    selectedItemId: string | null;
    buildDetailPath: (id: string, section?: string) => string;
    originLabel?: string;
    onFeedback?: unknown;
    onReportContent?: ReelHandler;
    onReportUser?: ReelHandler;
    onBlockUser?: ReelHandler;
  }) {
    const item = items.find((candidate) => candidate.id === selectedItemId);
    return isOpen && item ? (
      <div role="dialog" aria-label={`${item.title} Showcase reel`}>
        <span>{item.title}</span>
        <a href={buildDetailPath(item.id, 'resources')}>Post details</a>
        <span>Closes to {originLabel ?? 'Explore'}</span>
        {onFeedback ? <button type="button">Feed rows</button> : null}
        {onReportContent ? <button type="button" onClick={() => void onReportContent(item)}>Report content</button> : null}
        {onReportUser ? <button type="button" onClick={() => void onReportUser(item)}>Report user</button> : null}
        {onBlockUser ? <button type="button" onClick={() => void onBlockUser(item)}>Block user</button> : null}
      </div>
    ) : null;
  },
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: { access_token: 'profile-token', user: { id: 'owner-1' } },
    user: { id: 'owner-1' },
  }),
}));

vi.mock('@/components/HoverVideo', () => ({
  HoverVideo: ({ src, poster }: { src: string; poster?: string | null }) => (
    <video data-testid="profile-video" data-src={src} poster={poster ?? undefined} />
  ),
}));

vi.mock('@/components/OptimizedPreviewImage', () => ({
  OptimizedPreviewImage: ({ previewSrc, alt }: { previewSrc: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={previewSrc} alt={alt} />
  ),
}));

vi.mock('@/components/MediaDetailsPreviewModal', () => ({
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    pushMock.mockReset();
    resetFeedbackState();
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

  // The one way to see whom you blocked and take a block back.
  it('links to the list of blocked users', async () => {
    render(<OwnerProfileMediaHub creator={{ id: 'owner-1', username: 'owner', name: 'Owner', avatar: null }} />);

    expect(screen.getByRole('link', { name: /blocked users/i })).toHaveAttribute('href', '/profile/blocked');
    await screen.findByRole('button', { name: /open public post/i });
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

  it('shows an explicit note for a creation whose only source is gone instead of a broken tile', async () => {
    const baseFetch = fetch as unknown as (input: RequestInfo | URL) => Promise<Response>;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/generations?includeArchived=false&detail=summary')) {
        return Promise.resolve(response({
          generations: [{
            id: 'gone-generation',
            status: 'succeeded',
            created_at: '2026-03-05T10:00:00.000Z',
            duration: 5,
            model: 'kling-2.6/motion-control',
            category: 'motion',
            title: 'Expired clip',
            media: null,
            preview_url: null,
            linked_post_id: null,
            source_unavailable_at: '2026-09-08T06:15:00.000Z',
          }],
          pagination: { hasMore: false, nextCursor: null },
        }));
      }
      return baseFetch(input);
    }));

    render(<OwnerProfileMediaHub creator={{ id: 'owner-1', username: 'owner', name: 'Owner', avatar: null }} />);

    await screen.findByRole('button', { name: /open public post/i });
    fireEvent.click(screen.getByRole('tab', { name: /creations 1/i }));

    expect(screen.getByText('Expired clip')).toBeInTheDocument();
    expect(screen.getByText('This file is no longer available')).toBeInTheDocument();
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

  // The reel opened from your own profile had no ⋯ at all. Saved posts are
  // other people's, so their reel carries the three safety rows, as the app's
  // does; the reel over your own posts still has none.
  describe("the Saved reel's safety rows", () => {
    const owner = { id: 'owner-1', username: 'owner', name: 'Owner', avatar: null };
    const secondSavedPost: ShowcaseFeedItem = { ...savedPost, id: 'saved-post-2', title: 'Second by the same creator' };
    const otherSavedPost: ShowcaseFeedItem = {
      ...savedPost,
      id: 'saved-other',
      title: 'Saved from someone else',
      creator: { id: 'creator-3', username: 'creator-three', name: 'Creator Three', avatar: null },
    };
    const isSafetyRequest = (url: string) => /^\/api\/(moderation\/|posts\/[^/]+\/report$)/.test(url);
    // The page's own requests answer as in the other tests; the saved list and
    // the report and block requests answer as given here.
    const answerRequests = (savedItems: ShowcaseFeedItem[], ok = true) => {
      const answerPage = fetch as unknown as (input: RequestInfo | URL) => Promise<Response>;
      const sent: Array<{ url: string; init?: RequestInit }> = [];
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (isSafetyRequest(url)) {
          sent.push({ url, init });
          return Promise.resolve({
            ok,
            status: ok ? 200 : 500,
            json: async () => (ok ? { success: true } : { error: 'Failed to block user.' }),
          } as Response);
        }
        if (url.startsWith('/api/showcase/saved-media?')) {
          return response({ items: savedItems, pageInfo: { hasMore: false, nextOffset: null } });
        }
        return answerPage(input);
      }));
      return sent;
    };
    const toasts = () => readFeedbackSnapshot().toasts.map(({ tone, message }) => ({ tone, message }));
    const openSavedReel = async (title: RegExp) => {
      render(<OwnerProfileMediaHub creator={owner} />);
      await screen.findByRole('button', { name: /open public post/i });
      fireEvent.click(screen.getByRole('tab', { name: /saved/i }));
      fireEvent.click(await screen.findByRole('button', { name: title }));
    };

    it('gives the Saved reel Report content, Report user and Block user, and no feed rows', async () => {
      answerRequests([savedPost]);
      await openSavedReel(/open saved inspiration/i);

      expect(screen.getByRole('dialog', { name: /saved inspiration showcase reel/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Report content' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Report user' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Block user' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Feed rows' })).not.toBeInTheDocument();
    });

    it('gives the reel over your own posts none of them', async () => {
      render(<OwnerProfileMediaHub creator={owner} />);
      fireEvent.click(await screen.findByRole('button', { name: /open public post/i }));

      const reel = screen.getByRole('dialog', { name: /public post showcase reel/i });
      // Its close button goes back to the profile, not to Explore, and says so.
      expect(reel).toHaveTextContent('Closes to Profile');
      expect(screen.queryByRole('button', { name: 'Report content' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Report user' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Block user' })).not.toBeInTheDocument();
    });

    it('reports a saved post as from saved posts, and leaves it saved', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const sent = answerRequests([savedPost]);
      await openSavedReel(/open saved inspiration/i);

      fireEvent.click(screen.getByRole('button', { name: 'Report content' }));

      await waitFor(() => expect(sent).toHaveLength(1));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Report content?'));
      expect(sent[0].url).toBe('/api/posts/saved-post/report');
      expect(sent[0].init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer profile-token' } });
      expect(JSON.parse(String(sent[0].init?.body))).toEqual({
        reason: 'unsafe_content',
        details: 'Reported from saved posts on the web profile.',
      });
      await waitFor(() => expect(toasts()).toEqual([
        { tone: 'success', message: 'Content reported. Our moderation team will take a look.' },
      ]));
      expect(screen.getByRole('dialog', { name: /saved inspiration showcase reel/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /open saved inspiration/i })).toBeInTheDocument();
    });

    it('reports the creator of a saved post as the reel files one', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      const sent = answerRequests([savedPost]);
      await openSavedReel(/open saved inspiration/i);

      fireEvent.click(screen.getByRole('button', { name: 'Report user' }));

      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].url).toBe('/api/moderation/reports');
      expect(JSON.parse(String(sent[0].init?.body))).toEqual({
        targetType: 'user',
        targetId: 'creator-2',
        reason: 'harassment',
        sourceSurface: 'showcase-reel',
      });
      await waitFor(() => expect(toasts()).toEqual([
        { tone: 'success', message: 'Creator reported. Our moderation team will take a look.' },
      ]));
    });

    it("blocks a creator, drops every saved post of theirs, and moves the reel to what is left", async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const sent = answerRequests([savedPost, secondSavedPost, otherSavedPost]);
      await openSavedReel(/open saved inspiration/i);

      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      expect(await screen.findByRole('dialog', { name: /saved from someone else showcase reel/i })).toBeInTheDocument();
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Block this creator?'));
      expect(sent.map((request) => request.url)).toEqual(['/api/moderation/blocks/creator-2']);
      expect(sent[0].init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer profile-token' } });
      expect(toasts()).toEqual([
        { tone: 'success', message: 'Creator Two is blocked. Their posts are gone from your feed.' },
      ]);
      expect(screen.queryByRole('button', { name: /open saved inspiration/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /open second by the same creator/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /open saved from someone else/i })).toBeInTheDocument();
      expect(window.location.search).toContain('post=saved-other');
    });

    it('closes the reel when the blocked creator made everything that was saved', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      answerRequests([savedPost, secondSavedPost]);
      await openSavedReel(/open second by the same creator/i);

      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      await waitFor(() => expect(screen.queryByRole('dialog', { name: /showcase reel/i })).not.toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /open saved inspiration/i })).not.toBeInTheDocument();
      expect(screen.getByText('Nothing saved yet')).toBeInTheDocument();
      // Closing steps back over the entry the reel pushed, which lands a moment
      // later: the address stops naming a post, and stays on the Saved tab.
      await waitFor(() => expect(window.location.search).toBe('?tab=saved'));
    });

    it('sends nothing and keeps the saved posts when the question is declined', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const sent = answerRequests([savedPost]);
      await openSavedReel(/open saved inspiration/i);

      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      await waitFor(() => expect(confirm).toHaveBeenCalled());
      expect(sent).toHaveLength(0);
      expect(toasts()).toEqual([]);
      expect(screen.getByRole('dialog', { name: /saved inspiration showcase reel/i })).toBeInTheDocument();
    });

    it('keeps the saved posts and says why when the block fails', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      answerRequests([savedPost], false);
      await openSavedReel(/open saved inspiration/i);

      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      await waitFor(() => expect(toasts()).toEqual([
        { tone: 'error', message: 'Could not block this creator. Failed to block user.' },
      ]));
      expect(screen.getByRole('dialog', { name: /saved inspiration showcase reel/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /open saved inspiration/i })).toBeInTheDocument();
    });
  });
});
