import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import OwnerProfileMediaHub from '@/app/profile/OwnerProfileMediaHub';
import { readFeedbackSnapshot, resetFeedbackState } from '@/components/feedback-state';
import { resetSaverNoticeForTests } from '@/components/saver-notice';
import { createReelEntryState } from '@/lib/reel-history-entry';
import type { ShowcaseFeedItem } from '@/lib/showcase';

// One router object for every render, as Next's is.
const router = vi.hoisted(() => ({ push: vi.fn() }));
const pushMock = router.push;

// The query a microtask behind the page's own history writes, as Next's is
// (`fixtures/router-search-params.ts`).
vi.mock('next/navigation', async () => {
  const { useRouterSearchParams } = await import('./fixtures/router-search-params');
  return {
    useRouter: () => router,
    usePathname: () => '/profile',
    useSearchParams: useRouterSearchParams,
  };
});

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
    onToggleSave,
    onClose,
    onMediaIndexChange,
    originLabel,
    loadMoreError,
  }: {
    isOpen: boolean;
    items: ShowcaseFeedItem[];
    selectedItemId: string | null;
    buildDetailPath: (id: string, section?: string) => string;
    onClose: () => void;
    onMediaIndexChange: (index: number) => void;
    originLabel?: string;
    onFeedback?: unknown;
    onReportContent?: ReelHandler;
    onReportUser?: ReelHandler;
    onBlockUser?: ReelHandler;
    onToggleSave?: (id: string) => void | Promise<void>;
    loadMoreError?: string | null;
  }) {
    const item = items.find((candidate) => candidate.id === selectedItemId);
    return isOpen && item ? (
      <div role="dialog" aria-label={`${item.title} Showcase reel`}>
        <span>{item.title}</span>
        <span>{item.commentCount} comments · {item.visibility ?? 'public'}</span>
        {loadMoreError ? <span role="alert">{loadMoreError}</span> : null}
        <a href={buildDetailPath(item.id, 'resources')}>Post details</a>
        <span>Closes to {originLabel ?? 'Explore'}</span>
        <button type="button" onClick={onClose}>Close reel</button>
        <button type="button" onClick={() => onMediaIndexChange(1)}>Next slide</button>
        {onToggleSave ? <button type="button" onClick={() => void onToggleSave(item.id)}>Toggle save</button> : null}
        {onFeedback ? <button type="button">Feed rows</button> : null}
        {onReportContent ? <button type="button" onClick={() => void onReportContent(item)}>Report content</button> : null}
        {onReportUser ? <button type="button" onClick={() => void onReportUser(item)}>Report user</button> : null}
        {onBlockUser ? <button type="button" onClick={() => void onBlockUser(item)}>Block user</button> : null}
      </div>
    ) : null;
  },
}));

// One object for the whole file: a test swaps its session to stand for a
// token refresh, and the hook hands the hub whatever it holds now.
const authState = vi.hoisted(() => ({
  session: { access_token: 'profile-token', user: { id: 'owner-1' } },
  user: { id: 'owner-1' },
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => authState,
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
  default: ({ isOpen, title, prompt, src, inputMedia, additionalMedia, onClose }: {
    isOpen: boolean;
    title: string;
    prompt?: string;
    src: string | null;
    inputMedia?: Array<{ label: string }> | null;
    additionalMedia?: Array<{ src: string }> | null;
    onClose: () => void;
  }) => isOpen ? (
    <div role="dialog" aria-label={`${title} creation preview`}>
      <span>{title}</span>
      {prompt ? <span>{prompt}</span> : null}
      <span data-testid="preview-src">{src}</span>
      <span data-testid="preview-inputs">{(inputMedia ?? []).map((item) => item.label).join(', ')}</span>
      <span data-testid="preview-more-outputs">{(additionalMedia ?? []).map((item) => item.src).join(' ')}</span>
      <button type="button" onClick={onClose}>Close preview</button>
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

// What the server counted for this owner, as `/profile` hands it over.
const TOTALS = { creations: 1, posts: 2, archivedPosts: 0, saved: 1 };

describe('OwnerProfileMediaHub', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    pushMock.mockReset();
    resetFeedbackState();
    authState.session = { access_token: 'profile-token', user: { id: 'owner-1' } };
    authState.user = { id: 'owner-1' };
    window.history.replaceState(null, '', '/profile');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/content-preferences') {
        return response({ showMature: false });
      }
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

  // Mature content could only be changed from the gate on an NSFW post.
  it('keeps the mature-content setting beside Blocked users', async () => {
    render(<OwnerProfileMediaHub creator={{ id: 'owner-1', username: 'owner', name: 'Owner', avatar: null }} />);

    const shortcuts = screen.getByRole('region', { name: 'Creator account shortcuts' });
    expect(within(shortcuts).getByRole('link', { name: /blocked users/i })).toBeInTheDocument();
    expect(await within(shortcuts).findByRole('switch', { name: 'Mature content' })).toHaveAttribute('aria-checked', 'false');
    await screen.findByRole('button', { name: /open public post/i });
  });

  describe('the header totals', () => {
    const owner = { id: 'owner-1', username: 'owner', name: 'Owner', avatar: null };
    const statFor = (label: string) => screen.getByText(label, { selector: 'dt' }).parentElement?.querySelector('dd')?.textContent;

    // The header and the tab chips printed the lengths of the pages loaded so
    // far, 24 a page, and the Wallet said "Open"; the app and the web Studio
    // print the server's totals.
    it("prints the server's totals before any page loads, and the withdrawable balance in the Wallet", async () => {
      render(
        <OwnerProfileMediaHub
          creator={owner}
          stats={{ creations: 200, posts: 31, archivedPosts: 4, saved: 7 }}
          walletBalance={{ availableUsd: '$1,234.56' }}
        />
      );

      expect(statFor('Creations')).toBe('200');
      expect(statFor('Posts')).toBe('31');
      expect(statFor('Saved')).toBe('7');
      expect(screen.getByRole('tab', { name: 'Posts 31' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Saved 7' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Creations 200' })).toBeInTheDocument();
      const wallet = screen.getByRole('link', { name: /wallet/i });
      expect(wallet).toHaveTextContent('$1,234.56');
      expect(wallet).toHaveTextContent('Available to withdraw');

      // Two posts load; the number stays the one the server counted.
      await screen.findByRole('button', { name: /open public post/i });
      expect(statFor('Posts')).toBe('31');
    });

    // The Wallet printed lifetime earnings, which stayed whole after a payout
    // request moved the balance to $0.00; it prints what can be withdrawn.
    it('draws — for a count the server could not read, never the loaded pages, and $0.00 for an empty balance', async () => {
      render(
        <OwnerProfileMediaHub
          creator={owner}
          stats={null}
          walletBalance={{ availableUsd: '$0.00' }}
        />
      );

      await screen.findByRole('button', { name: /open public post/i });
      expect(statFor('Creations')).toBe('—');
      expect(statFor('Posts')).toBe('—');
      expect(statFor('Saved')).toBe('—');
      // A count it does not have is not read out as one.
      expect(screen.getByRole('tab', { name: 'Posts' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /wallet/i })).toHaveTextContent('$0.00');
      expect(screen.getByRole('link', { name: /wallet/i })).toHaveTextContent('Available to withdraw');
    });

    it('draws — and "Balance unavailable" in the Wallet when the payout balance could not be read', async () => {
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} walletBalance={null} />);

      const wallet = screen.getByRole('link', { name: /wallet/i });
      expect(wallet).toHaveTextContent('—');
      expect(wallet).toHaveTextContent('Balance unavailable');
      expect(wallet).not.toHaveTextContent('Available to withdraw');
      expect(wallet).toHaveAttribute('href', '/marketplace/sell');
      await screen.findByRole('button', { name: /open public post/i });
    });

    it('takes an unsave in the Saved reel off the Saved total, and puts a save back on', async () => {
      const answerPage = fetch as unknown as (input: RequestInfo | URL) => Promise<Response>;
      const saveBodies: unknown[] = [];
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/showcase/save') {
          const body = JSON.parse(String(init?.body)) as { shouldSave: boolean };
          saveBodies.push(body);
          return response({ success: true, isSaved: body.shouldSave, saveCount: 4 });
        }
        return answerPage(input);
      }));
      // Told on an earlier page and on record, under the signed-in account:
      // its save may name it.
      window.localStorage.setItem('magicbooklet:saver-notice:v2:owner-1', 'recorded');
      render(<OwnerProfileMediaHub creator={owner} stats={{ ...TOTALS, saved: 7 }} />);
      await screen.findByRole('button', { name: /open public post/i });
      fireEvent.click(screen.getByRole('tab', { name: /saved/i }));
      fireEvent.click(await screen.findByRole('button', { name: /open saved inspiration/i }));

      fireEvent.click(screen.getByRole('button', { name: 'Toggle save' }));

      await waitFor(() => expect(statFor('Saved')).toBe('6'));
      expect(screen.getByRole('tab', { name: 'Saved 6' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Toggle save' }));

      await waitFor(() => expect(statFor('Saved')).toBe('7'));
      expect(saveBodies).toMatchObject([
        { postId: 'saved-post', shouldSave: false },
        { postId: 'saved-post', shouldSave: true, creatorSeesSaver: true },
      ]);
      window.localStorage.clear();
      resetSaverNoticeForTests();
    });
  });

  // A refreshed token swaps the session object (about hourly, and on coming
  // back to a long-idle tab). The hub read that as a new account: it blanked
  // every tab, read page 1 of all three again, dropped the pages loaded with
  // Load more, and closed a reel open on one of them.
  it('keeps the loaded pages and the open reel when the token is refreshed', async () => {
    const secondPagePost = { ...publicPost, id: 'post-page-two', title: 'Second page post' };
    const answerPage = fetch as unknown as (input: RequestInfo | URL) => Promise<Response>;
    const listRequests: string[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (/^\/api\/(posts|showcase\/saved-media|generations)\?/.test(url)) listRequests.push(url);
      if (url.startsWith('/api/posts?')) {
        return url.includes('offset=24')
          ? response({ posts: [secondPagePost], pageInfo: { hasMore: false, nextOffset: null } })
          : response({ posts: [publicPost], pageInfo: { hasMore: true, nextOffset: 24 } });
      }
      return answerPage(input);
    }));
    const owner = { id: 'owner-1', username: 'owner', name: 'Owner', avatar: null };
    const { rerender } = render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
    await screen.findByRole('button', { name: /open public post/i });
    fireEvent.click(screen.getByRole('button', { name: 'Load more posts' }));
    fireEvent.click(await screen.findByRole('button', { name: /open second page post/i }));
    await waitFor(() => expect(listRequests).toHaveLength(4));

    authState.session = { access_token: 'refreshed-token', user: { id: 'owner-1' } };
    authState.user = { id: 'owner-1' };
    rerender(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(listRequests).toHaveLength(4);
    expect(screen.getByRole('dialog', { name: /second page post showcase reel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open public post/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open second page post/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Posts 2' })).toBeInTheDocument();
  });

  it('keeps raw creations in a focused preview instead of the Showcase reel', async () => {
    render(<OwnerProfileMediaHub creator={{ id: 'owner-1', username: 'owner', name: 'Owner', avatar: null }} stats={TOTALS} />);

    await screen.findByRole('button', { name: /open public post/i });
    fireEvent.click(screen.getByRole('tab', { name: /creations 1/i }));
    fireEvent.click(await screen.findByRole('button', { name: /open raw frame/i }));

    expect(screen.getByRole('dialog', { name: /raw frame creation preview/i })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /showcase reel/i })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Owner-only creation prompt')).toBeInTheDocument());
  });

  // The browser's Back or Forward onto an entry the page pushed for a post or a creation:
  // the entry says so (`reel-history-entry.ts`). Popstate took every entry naming one for a
  // linked one's, so after Forward the close replaced the page's entry: the profile stood
  // twice in history, and the next Back stayed on it
  // (archive/web-reel-forward-history-2026-10-23).
  describe("a reel or creation the browser's Back or Forward reaches again", () => {
    const owner = { id: 'owner-1', username: 'owner', name: 'Owner', avatar: null };

    it("goes Back from a post's reel that Forward opened again on its own entry", async () => {
      const pushState = vi.spyOn(window.history, 'pushState');
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
      fireEvent.click(await screen.findByRole('button', { name: /open public post/i }));
      expect(pushState).toHaveBeenLastCalledWith(createReelEntryState('post'), '', '/profile?tab=posts&post=post-public');

      act(() => {
        window.history.back();
      });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /public post showcase reel/i })).not.toBeInTheDocument());
      act(() => {
        window.history.forward();
      });
      const reel = await screen.findByRole('dialog', { name: /public post showcase reel/i });

      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      const replaceState = vi.spyOn(window.history, 'replaceState');
      fireEvent.click(within(reel).getByRole('button', { name: 'Close reel' }));
      expect(back).toHaveBeenCalledTimes(1);
      expect(replaceState).not.toHaveBeenCalled();
    });

    it('goes Back from a creation that Forward opened again on its own entry', async () => {
      const pushState = vi.spyOn(window.history, 'pushState');
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
      await screen.findByRole('button', { name: /open public post/i });
      fireEvent.click(screen.getByRole('tab', { name: /creations 1/i }));
      // A tab's entry is a plain one.
      expect(pushState).toHaveBeenLastCalledWith(null, '', '/profile?tab=creations');
      fireEvent.click(await screen.findByRole('button', { name: /open raw frame/i }));
      expect(pushState).toHaveBeenLastCalledWith(createReelEntryState('generation'), '', '/profile?tab=creations&generation=raw-generation');

      act(() => {
        window.history.back();
      });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /raw frame creation preview/i })).not.toBeInTheDocument());
      act(() => {
        window.history.forward();
      });
      const preview = await screen.findByRole('dialog', { name: /raw frame creation preview/i });

      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      const replaceState = vi.spyOn(window.history, 'replaceState');
      fireEvent.click(within(preview).getByRole('button', { name: 'Close preview' }));
      expect(back).toHaveBeenCalledTimes(1);
      expect(replaceState).not.toHaveBeenCalled();
    });

    // A slide replaces the reel's entry, which stays the reel's own.
    it('goes Back after Forward from a reel that had moved on to another slide', async () => {
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
      fireEvent.click(await screen.findByRole('button', { name: /open public post/i }));
      const opened = await screen.findByRole('dialog', { name: /public post showcase reel/i });
      fireEvent.click(within(opened).getByRole('button', { name: 'Next slide' }));
      expect(window.location.search).toBe('?tab=posts&post=post-public&media=1');

      act(() => {
        window.history.back();
      });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /public post showcase reel/i })).not.toBeInTheDocument());
      act(() => {
        window.history.forward();
      });
      const reel = await screen.findByRole('dialog', { name: /public post showcase reel/i });

      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      fireEvent.click(within(reel).getByRole('button', { name: 'Close reel' }));
      expect(back).toHaveBeenCalledTimes(1);
    });

    // The hub mounts on an entry it pushed: a reload, or a Back from a page the reel or
    // the creation linked to ("Post details", "Turn into post"), where the page mounts again.
    it("goes Back from a post's reel whose own entry the hub mounted on", async () => {
      window.history.replaceState(createReelEntryState('post'), '', '/profile?tab=posts&post=post-public');
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
      const reel = await screen.findByRole('dialog', { name: /public post showcase reel/i });

      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      const replaceState = vi.spyOn(window.history, 'replaceState');
      fireEvent.click(within(reel).getByRole('button', { name: 'Close reel' }));
      expect(back).toHaveBeenCalledTimes(1);
      expect(replaceState).not.toHaveBeenCalled();
    });

    it('goes Back from a creation whose own entry the hub mounted on', async () => {
      window.history.replaceState(createReelEntryState('generation'), '', '/profile?tab=creations&generation=raw-generation');
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
      const preview = await screen.findByRole('dialog', { name: /raw frame creation preview/i });

      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      const replaceState = vi.spyOn(window.history, 'replaceState');
      fireEvent.click(within(preview).getByRole('button', { name: 'Close preview' }));
      expect(back).toHaveBeenCalledTimes(1);
      expect(replaceState).not.toHaveBeenCalled();
    });

    // A linked post's entry, and every entry from before the page marked its own: opened
    // by address, so the close replaces it, also once Back has reached it.
    it('replaces the entry of a post Back reached on an entry the page did not push', async () => {
      window.history.replaceState(null, '', '/profile?tab=posts&post=post-public');
      window.history.pushState(null, '', '/profile?tab=posts');
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
      await screen.findByRole('button', { name: /open public post/i });

      act(() => {
        window.history.back();
      });
      const reel = await screen.findByRole('dialog', { name: /public post showcase reel/i });

      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      const replaceState = vi.spyOn(window.history, 'replaceState');
      fireEvent.click(within(reel).getByRole('button', { name: 'Close reel' }));
      expect(back).not.toHaveBeenCalled();
      expect(replaceState).toHaveBeenLastCalledWith(null, '', '/profile?tab=posts');
    });

    it('replaces the entry of a creation Back reached on an entry the page did not push', async () => {
      window.history.replaceState(null, '', '/profile?tab=creations&generation=raw-generation');
      window.history.pushState(null, '', '/profile?tab=creations');
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
      await screen.findByRole('button', { name: /open raw frame/i });

      act(() => {
        window.history.back();
      });
      const preview = await screen.findByRole('dialog', { name: /raw frame creation preview/i });

      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      const replaceState = vi.spyOn(window.history, 'replaceState');
      fireEvent.click(within(preview).getByRole('button', { name: 'Close preview' }));
      expect(back).not.toHaveBeenCalled();
      expect(replaceState).toHaveBeenLastCalledWith(null, '', '/profile?tab=creations');
    });
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

    render(<OwnerProfileMediaHub creator={{ id: 'owner-1', username: 'owner', name: 'Owner', avatar: null }} stats={TOTALS} />);

    await screen.findByRole('button', { name: /open public post/i });
    fireEvent.click(screen.getByRole('tab', { name: /creations 1/i }));

    expect(await screen.findByText('Expired clip')).toBeInTheDocument();
    expect(screen.getByText('This file is no longer available')).toBeInTheDocument();
  });

  it('keeps failed runs out of the grid but reachable, and never as a dead control', async () => {
    render(<OwnerProfileMediaHub creator={{ id: 'owner-1', username: 'owner', name: 'Owner', avatar: null }} stats={TOTALS} />);

    await screen.findByRole('button', { name: /open public post/i });
    fireEvent.click(screen.getByRole('tab', { name: /creations 1/i }));

    expect(await screen.findByRole('button', { name: /open raw frame/i })).toBeInTheDocument();
    expect(screen.queryByText('Failed clip')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /failed runs/i }));

    expect(screen.getByText('Failed clip')).toBeInTheDocument();
    expect(screen.queryByText('Raw frame')).not.toBeInTheDocument();
    // No media to open, so the card is a record rather than a control that
    // does nothing when pressed.
    expect(screen.queryByRole('button', { name: /open failed clip/i })).not.toBeInTheDocument();
  });

  // A close clears the selection a render before the query lets go of the
  // creation: the router takes the page's own replaceState a microtask later,
  // and Back's popstate comes after the close. The effect that opens the
  // creation the address names took that render for a new request, so a
  // creation opened by address opened again after its Close, with no
  // `generation` left in the address; and details that came after a close
  // opened it again too (archive/web-profile-creation-close-2026-10-23).
  describe('a creation the reader closed', () => {
    const owner = { id: 'owner-1', username: 'owner', name: 'Owner', avatar: null };
    const noPreview = () => expect(screen.queryByRole('dialog', { name: /creation preview/i })).not.toBeInTheDocument();
    // Holds back the details read of a creation until the returned call sends it.
    const holdDetails = (generationId: string) => {
      const answer = fetch as unknown as (input: RequestInfo | URL) => Promise<Response>;
      let send: () => void = () => {
        throw new Error(`No details read of ${generationId} was held`);
      };
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => (
        String(input).includes(`/api/generations?includeArchived=false&id=${generationId}`)
          ? new Promise<Response>((resolve) => {
            send = () => resolve(answer(input));
          })
          : answer(input)
      )));
      return () => send();
    };
    // Lets what was sent (and the router's own update) reach the page.
    const settle = () => act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    const openRawFrameFromItsTile = async () => {
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
      await screen.findByRole('button', { name: /open public post/i });
      fireEvent.click(screen.getByRole('tab', { name: /creations 1/i }));
      fireEvent.click(await screen.findByRole('button', { name: /open raw frame/i }));
      return screen.findByRole('dialog', { name: /raw frame creation preview/i });
    };

    it('stays closed when the address had opened it', async () => {
      window.history.replaceState(null, '', '/profile?tab=creations&generation=raw-generation');
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
      const preview = await screen.findByRole('dialog', { name: /raw frame creation preview/i });

      fireEvent.click(within(preview).getByRole('button', { name: 'Close preview' }));
      await settle();

      expect(window.location.search).toBe('?tab=creations');
      noPreview();
      // Its tile still opens it.
      fireEvent.click(screen.getByRole('button', { name: /open raw frame/i }));
      expect(await screen.findByText('Owner-only creation prompt')).toBeInTheDocument();
    });

    it('stays closed until the popstate of the Back that closes it, when its details come meanwhile too', async () => {
      const sendDetails = holdDetails('raw-generation');
      const preview = await openRawFrameFromItsTile();

      // Until Back's popstate the address still names the creation.
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      fireEvent.click(within(preview).getByRole('button', { name: 'Close preview' }));
      await settle();
      expect(back).toHaveBeenCalledTimes(1);
      expect(window.location.search).toBe('?tab=creations&generation=raw-generation');
      noPreview();

      // The list takes the details, and the selection stays empty.
      sendDetails();
      await settle();
      noPreview();
    });

    // Opened by address on the page's own entry (a reload, or Back from a page
    // it linked to), its Close goes Back too; a page of the list can land first.
    it('stays closed until the popstate of the Back that closes it, when more creations load meanwhile', async () => {
      const answerPage = fetch as unknown as (input: RequestInfo | URL) => Promise<Response>;
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/generations?includeArchived=false&detail=summary')) {
          const page = await (await answerPage(input)).json();
          return url.includes('cursor=')
            ? response({ generations: [{ ...page.generations[0], id: 'older-generation', title: 'Older frame' }], pagination: { hasMore: false, nextCursor: null } })
            : response({ ...page, pagination: { hasMore: true, nextCursor: 'page-2' } });
        }
        return answerPage(input);
      }));
      window.history.replaceState(createReelEntryState('generation'), '', '/profile?tab=creations&generation=raw-generation');
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
      const preview = await screen.findByRole('dialog', { name: /raw frame creation preview/i });

      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      fireEvent.click(within(preview).getByRole('button', { name: 'Close preview' }));
      await settle();
      expect(back).toHaveBeenCalledTimes(1);
      noPreview();

      fireEvent.click(screen.getByRole('button', { name: 'Load more creations' }));
      expect(await screen.findByRole('button', { name: /open older frame/i })).toBeInTheDocument();
      noPreview();
    });

    it('stays closed when its details come after the Close, and Forward opens it again with them', async () => {
      const sendDetails = holdDetails('raw-generation');
      const preview = await openRawFrameFromItsTile();
      fireEvent.click(within(preview).getByRole('button', { name: 'Close preview' }));
      await waitFor(() => expect(window.location.search).toBe('?tab=creations'));
      noPreview();

      sendDetails();
      await settle();

      noPreview();
      expect(window.location.search).toBe('?tab=creations');
      window.history.forward();
      const reopened = await screen.findByRole('dialog', { name: /raw frame creation preview/i });
      expect(within(reopened).getByText('Owner-only creation prompt')).toBeInTheDocument();
    });

    it('keeps the creation opened next when the details of the one closed come', async () => {
      const answerPage = fetch as unknown as (input: RequestInfo | URL) => Promise<Response>;
      const secondCreation = {
        id: 'second-generation',
        output_url: 'https://example.com/second.jpg',
        preview_url: null,
        status: 'completed',
        created_at: '2026-07-06T00:00:00.000Z',
        model: 'image-model',
        category: 'image',
        title: 'Second frame',
        linked_post_id: null,
      };
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/generations?includeArchived=false&detail=summary')) {
          const page = await (await answerPage(input)).json();
          return response({ ...page, generations: [...page.generations, secondCreation] });
        }
        if (url.includes('/api/generations?includeArchived=false&id=second-generation')) {
          return response({ generations: [{ ...secondCreation, prompt: 'Second creation prompt', input_media: [] }] });
        }
        return answerPage(input);
      }));
      const sendFirstDetails = holdDetails('raw-generation');
      const first = await openRawFrameFromItsTile();
      fireEvent.click(within(first).getByRole('button', { name: 'Close preview' }));
      await waitFor(() => expect(window.location.search).toBe('?tab=creations'));
      fireEvent.click(screen.getByRole('button', { name: /open second frame/i }));
      const second = await screen.findByRole('dialog', { name: /second frame creation preview/i });
      await within(second).findByText('Second creation prompt');

      sendFirstDetails();
      await settle();

      expect(screen.getByRole('dialog', { name: /second frame creation preview/i })).toHaveTextContent('Second creation prompt');
      expect(screen.queryByRole('dialog', { name: /raw frame creation preview/i })).not.toBeInTheDocument();
      expect(window.location.search).toBe('?tab=creations&generation=second-generation');
    });

    // The viewer moves no focus, so Enter on a tile can press it again behind
    // it. A second entry naming the same creation left its Close going Back
    // onto the first, which still named it.
    it('pushes no second entry when the tile of the open creation is pressed again', async () => {
      const preview = await openRawFrameFromItsTile();
      await within(preview).findByText('Owner-only creation prompt');
      const pushState = vi.spyOn(window.history, 'pushState');

      fireEvent.click(screen.getByRole('button', { name: /open raw frame/i }));
      await settle();
      expect(pushState).not.toHaveBeenCalled();

      fireEvent.click(within(preview).getByRole('button', { name: 'Close preview' }));
      await waitFor(() => expect(window.location.search).toBe('?tab=creations'));
      noPreview();
    });
  });

  // The list answers each creation's summary (`detail=summary`: no inputs, no further
  // outputs), and its details come from a read of their own. A creation opened by its address
  // showed only the summary, one beyond the loaded pages opened nothing until a later Load more
  // popped it open over the grid, and the details of the one on screen came with its media
  // signed again, which mounted the viewer again and loaded its media again
  // (archive/web-history-follow-ups-2026-10-23).
  describe("a creation's details", () => {
    const owner = { id: 'owner-1', username: 'owner', name: 'Owner', avatar: null };
    const noPreview = () => expect(screen.queryByRole('dialog', { name: /creation preview/i })).not.toBeInTheDocument();
    const settle = () => act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    // A private file's address as one read signs it.
    const signed = (file: string, read: string) => `https://storage.example.com/${file}?token=${read}`;
    type Row = ReturnType<typeof summaryRow>;
    const summaryRow = (id: string, title: string, expiresAt: string | null = null) => ({
      id,
      output_url: signed(`${id}.jpg`, 'list'),
      preview_url: signed(`${id}-preview.jpg`, 'list'),
      media: { renditionUrl: null, expiresAt },
      status: 'completed',
      created_at: '2026-07-04T00:00:00.000Z',
      model: 'image-model',
      category: 'image',
      title,
      linked_post_id: null,
    });
    const detailsOf = (row: Row) => ({
      ...row,
      output_url: signed(`${row.id}.jpg`, 'details'),
      preview_url: signed(`${row.id}-preview.jpg`, 'details'),
      media: { renditionUrl: null, expiresAt: null },
      output_urls: [signed(`${row.id}.jpg`, 'details'), signed(`${row.id}-2.jpg`, 'details')],
      prompt: `${row.title} prompt`,
      input_media: [{
        id: `${row.id}-input`,
        generationId: row.id,
        mediaType: 'image',
        role: 'reference',
        label: `${row.title} input`,
        url: signed(`${row.id}-input.jpg`, 'details'),
        storagePath: null,
        sourceGenerationId: null,
        sortOrder: 0,
        metadata: {},
      }],
    });
    // Answers the list's first page, the page after it, and each details read (none for an id
    // `details` leaves out); returns the ids the details were read for.
    const answerCreations = (first: Row[], second: Row[] | null, details: Record<string, ReturnType<typeof detailsOf>>) => {
      const answerElse = fetch as unknown as (input: RequestInfo | URL) => Promise<Response>;
      const detailsReads: string[] = [];
      vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/generations?includeArchived=false&detail=summary')) {
          return url.includes('cursor=page-2')
            ? response({ generations: second ?? [], pagination: { hasMore: false, nextCursor: null } })
            : response({ generations: first, pagination: { hasMore: Boolean(second), nextCursor: second ? 'page-2' : null } });
        }
        const read = /\/api\/generations\?includeArchived=false&id=([^&]+)&limit=1$/.exec(url);
        if (read) {
          detailsReads.push(read[1]);
          return response({ generations: details[read[1]] ? [details[read[1]]] : [] });
        }
        return answerElse(input);
      }));
      return detailsReads;
    };

    it('reads the details of a creation its address opened', async () => {
      const row = summaryRow('gen-linked', 'Linked frame');
      const reads = answerCreations([row], null, { 'gen-linked': detailsOf(row) });
      window.history.replaceState(null, '', '/profile?tab=creations&generation=gen-linked');
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);

      const preview = await screen.findByRole('dialog', { name: /linked frame creation preview/i });
      expect(await within(preview).findByText('Linked frame prompt')).toBeInTheDocument();
      expect(within(preview).getByTestId('preview-inputs')).toHaveTextContent('Linked frame input');
      expect(within(preview).getByTestId('preview-more-outputs')).toHaveTextContent(signed('gen-linked-2.jpg', 'details'));
      expect(reads).toEqual(['gen-linked']);
    });

    it('opens one beyond the loaded pages from its details, and a later page leaves it closed after its Close', async () => {
      const first = summaryRow('gen-first', 'First frame');
      const far = summaryRow('gen-far', 'Far frame');
      answerCreations([first], [far], { 'gen-far': detailsOf(far) });
      window.history.replaceState(null, '', '/profile?tab=creations&generation=gen-far');
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);

      const preview = await screen.findByRole('dialog', { name: /far frame creation preview/i });
      expect(await within(preview).findByText('Far frame prompt')).toBeInTheDocument();
      fireEvent.click(within(preview).getByRole('button', { name: 'Close preview' }));
      await waitFor(() => expect(window.location.search).toBe('?tab=creations'));
      noPreview();

      fireEvent.click(screen.getByRole('button', { name: 'Load more creations' }));
      expect(await screen.findByRole('button', { name: /open far frame/i })).toBeInTheDocument();
      await settle();
      noPreview();
    });

    it('leaves one whose details could not be read closed when a later page brings it', async () => {
      const first = summaryRow('gen-first', 'First frame');
      const far = summaryRow('gen-far', 'Far frame');
      const reads = answerCreations([first], [far], {});
      window.history.replaceState(null, '', '/profile?tab=creations&generation=gen-far');
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
      expect(await screen.findByRole('button', { name: /open first frame/i })).toBeInTheDocument();
      await settle();
      expect(reads).toEqual(['gen-far']);
      noPreview();

      fireEvent.click(screen.getByRole('button', { name: 'Load more creations' }));
      expect(await screen.findByRole('button', { name: /open far frame/i })).toBeInTheDocument();
      await settle();
      noPreview();
    });

    it('keeps the media on screen when the details of the open creation come signed again', async () => {
      const row = summaryRow('gen-tile', 'Tile frame', new Date(Date.now() + 30 * 60_000).toISOString());
      answerCreations([row], null, { 'gen-tile': detailsOf(row) });
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
      await screen.findByRole('button', { name: /open public post/i });
      fireEvent.click(screen.getByRole('tab', { name: /creations 1/i }));
      fireEvent.click(await screen.findByRole('button', { name: /open tile frame/i }));

      const preview = await screen.findByRole('dialog', { name: /tile frame creation preview/i });
      expect(await within(preview).findByText('Tile frame prompt')).toBeInTheDocument();
      expect(within(preview).getByTestId('preview-src')).toHaveTextContent(signed('gen-tile.jpg', 'list'));
      expect(within(preview).getByTestId('preview-inputs')).toHaveTextContent('Tile frame input');
      // The main output is the file on screen, not a further output at the details' address.
      expect(within(preview).getByTestId('preview-more-outputs').textContent).toBe(signed('gen-tile-2.jpg', 'details'));
      // The grid's tile keeps its address too.
      expect(screen.getByRole('img', { name: 'Tile frame' })).toHaveAttribute('src', signed('gen-tile-preview.jpg', 'list'));
    });

    it("takes the details' addresses once the ones on screen have run out", async () => {
      const row = summaryRow('gen-old', 'Old frame', new Date(Date.now() - 60_000).toISOString());
      answerCreations([row], null, { 'gen-old': detailsOf(row) });
      render(<OwnerProfileMediaHub creator={owner} stats={TOTALS} />);
      await screen.findByRole('button', { name: /open public post/i });
      fireEvent.click(screen.getByRole('tab', { name: /creations 1/i }));
      fireEvent.click(await screen.findByRole('button', { name: /open old frame/i }));

      const preview = await screen.findByRole('dialog', { name: /old frame creation preview/i });
      expect(await within(preview).findByText('Old frame prompt')).toBeInTheDocument();
      expect(within(preview).getByTestId('preview-src')).toHaveTextContent(signed('gen-old.jpg', 'details'));
    });
  });

  // The reel opened from your own profile had no ⋯ at all. Saved posts are
  // other people's, so their reel carries the three safety rows, as the app's
  // does; the reel over your own posts still has none.
  // The reel takes comments on public posts only; the owner's unlisted post
  // reached it as public, with no comment count.
  it("hands the reel the owner's post with its visibility and comment count", async () => {
    const baseFetch = fetch as unknown as (input: RequestInfo | URL) => Promise<Response>;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/posts?')) {
        return response({
          posts: [{ ...publicPost, id: 'post-unlisted', title: 'Unlisted post', visibility: 'unlisted', commentCount: 4 }],
          pageInfo: { hasMore: false, nextOffset: null },
        });
      }
      return baseFetch(input);
    }));
    render(<OwnerProfileMediaHub creator={{ id: 'owner-1', username: 'owner', name: 'Owner', avatar: null }} />);

    fireEvent.click(await screen.findByRole('button', { name: /open unlisted post/i }));

    expect(screen.getByRole('dialog', { name: /unlisted post showcase reel/i }))
      .toHaveTextContent('4 comments · unlisted');
  });

  // The reel's own paging asked again at once after a failed page, without end.
  it('tells the reel when a page of saved posts fails to load', async () => {
    const baseFetch = fetch as unknown as (input: RequestInfo | URL) => Promise<Response>;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/saved-media?limit=24&offset=0')) {
        return response({ items: [savedPost], pageInfo: { hasMore: true, nextOffset: 24 } });
      }
      if (url.startsWith('/api/showcase/saved-media?limit=24&offset=24')) {
        return response({ error: 'Could not load saved posts.' }, false);
      }
      return baseFetch(input);
    }));
    render(<OwnerProfileMediaHub creator={{ id: 'owner-1', username: 'owner', name: 'Owner', avatar: null }} />);
    await screen.findByRole('button', { name: /open public post/i });
    fireEvent.click(screen.getByRole('tab', { name: /saved/i }));
    fireEvent.click(await screen.findByRole('button', { name: /open saved inspiration/i }));
    const reel = screen.getByRole('dialog', { name: /saved inspiration showcase reel/i });

    fireEvent.click(screen.getByRole('button', { name: 'Load more saved' }));

    expect(await within(reel).findByRole('alert')).toHaveTextContent('Could not load saved posts.');
  });

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

    it("takes the blocked creator's saved posts off the Saved total", async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      answerRequests([savedPost, secondSavedPost, otherSavedPost]);
      render(<OwnerProfileMediaHub creator={owner} stats={{ ...TOTALS, saved: 3 }} />);
      await screen.findByRole('button', { name: /open public post/i });
      fireEvent.click(screen.getByRole('tab', { name: /saved/i }));
      fireEvent.click(await screen.findByRole('button', { name: /open saved inspiration/i }));

      fireEvent.click(screen.getByRole('button', { name: 'Block user' }));

      expect(await screen.findByRole('tab', { name: 'Saved 1' })).toBeInTheDocument();
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
