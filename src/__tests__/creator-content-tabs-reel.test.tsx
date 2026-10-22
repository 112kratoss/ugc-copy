import type { AnchorHTMLAttributes, HTMLAttributes, MouseEvent, ReactNode } from 'react';
import { useMemo, useSyncExternalStore } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreatorContentTabs } from '@/app/creators/[username]/CreatorContentTabs';
import type { CreatorProfilePageData } from '@/lib/creator-profile';

// The creator page with the real reel and the real thread, for what the
// stand-in reel of `creator-content-tabs.test.tsx` cannot press: the reel's own
// Close button and creator link, and a comment count that arrives while the
// reel is open.

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
// Who hears a link's navigation; see the `next/link` stand-in below.
const navigation = vi.hoisted(() => ({ listeners: new Set<() => void>() }));

// Next's `useSearchParams` re-renders its readers when the URL changes: after
// the page's own pushState and replaceState, after Back and Forward, and after
// a link to the page it is on. `useSyncExternalStore` reads the URL in every
// render, so a render after Close sees the URL Close left. It runs ahead of
// Next, which keeps the old URL until a transition commits the new one; the
// tests below need only that a later render sees it.
function subscribeToUrl(onChange: () => void) {
  window.addEventListener('popstate', onChange);
  navigation.listeners.add(onChange);
  return () => {
    window.removeEventListener('popstate', onChange);
    navigation.listeners.delete(onChange);
  };
}

vi.mock('next/navigation', () => ({
  usePathname: () => '/creators/creator-name',
  useRouter: () => routerMock,
  useSearchParams: () => {
    const search = useSyncExternalStore(subscribeToUrl, () => window.location.search);
    return useMemo(() => new URLSearchParams(search), [search]);
  },
}));

// A link is Next's navigation without a page load: the address changes with a
// pushState and the page's readers of the query render again. No popstate
// fires, so the page's own popstate listener does not hear it; on the page the
// link names, the page stays mounted and keeps its state.
vi.mock('next/link', () => ({
  default: ({
    href,
    prefetch,
    children,
    onClick,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean; children: ReactNode }) => (
    <a
      href={href}
      data-prefetch={prefetch === undefined ? undefined : String(prefetch)}
      {...props}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        window.history.pushState(null, '', href);
        navigation.listeners.forEach((listener) => listener());
      }}
    >
      {children}
    </a>
  ),
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: null,
    user: null,
    credits: null,
    marketplaceSpendableCredits: null,
    updateCredits: vi.fn(),
    isLoading: false,
  }),
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    span: ({ children, ...props }: HTMLAttributes<HTMLSpanElement>) => <span {...props}>{children}</span>,
  },
  useReducedMotion: () => false,
}));

const item: CreatorProfilePageData['items'][number] = {
  id: 'item-1',
  mediaUrl: 'https://example.com/creation.jpg',
  mediaKind: 'image',
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
  canRemix: false,
};

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
    publicCreations: 1,
    totalSaves: 12,
    totalRemixes: 4,
    unlocks: 0,
    totalUnlockSales: 0,
    toolsUsed: [],
  },
  items: [item],
  pageInfo: { hasMore: false, limit: 24, offset: 0, nextOffset: null, nextLimit: null },
};

function renderCreatorPage() {
  return render(<CreatorContentTabs initialData={initialData} profilePath="/creators/creator-name" />);
}

const queryReel = () => screen.queryByRole('dialog', { name: 'Creator reel viewer' });

/**
 * Opens the thread and presses the reel's Close in the slot after the commit
 * that drew the count the thread read, before that commit's passive effects
 * have run. That commit also took the count into the page's list, so the
 * page's URL effect is among those effects, holding the URL from before Close:
 * it selects the post again after Close cleared it.
 *
 * jsdom leaves those effects for a later task (React flushes them on
 * `setImmediate`), and a mutation observer's callback, a microtask after the
 * commit, takes the slot every time. In Chromium the same press closed the
 * reel in four probe runs out of four (2026-10-22): the three traced ones ran
 * those effects inside the commit's own task, before the callback. The page
 * must close the reel whichever comes first.
 */
async function pressCloseAsTheCountArrives(reel: HTMLElement) {
  let pressed = false;
  const observer = new MutationObserver(() => {
    if (!reel.querySelector('button[aria-label="Hide comments on Campaign Frame (3)"]')) return;
    observer.disconnect();
    pressed = true;
    fireEvent.click(within(reel).getByRole('button', { name: 'Creator' }));
  });
  observer.observe(reel, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-label'] });
  fireEvent.click(await within(reel).findByRole('button', { name: 'Show comments on Campaign Frame (0)' }));
  await waitFor(() => expect(pressed).toBe(true));
}

describe('CreatorContentTabs with the reel', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/creators/creator-name');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/posts/item-1/comments')) {
        return {
          ok: true,
          json: async () => ({
            postId: 'item-1',
            postCreatorId: 'creator-1',
            commentCount: 3,
            comments: [],
            pageInfo: { hasMore: false, nextOffset: null, limit: 20, offset: 0 },
          }),
        };
      }
      return { ok: true, json: async () => ({ success: true }) };
    }));
    // The reel scrolls the opened thread into view; jsdom has no element scrolling.
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The reel's creator link leads to the page the reel is open on. The page
  // stays and keeps its state, the address loses `?post`, and the reel stayed
  // open over it; opened from a tile, the next Close went Back to the post and
  // opened it again (both seen in Chromium on 2026-10-22).
  describe("the creator link, on that creator's page", () => {
    it('closes a linked post', async () => {
      window.history.replaceState(null, '', '/creators/creator-name?post=item-1');
      renderCreatorPage();

      const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });
      fireEvent.click(within(reel).getByRole('link', { name: /Creator Name/ }));

      await waitFor(() => expect(queryReel()).not.toBeInTheDocument());
      expect(window.location.search).toBe('');
    }, 15_000);

    it('closes a post opened from its tile, and Back opens it again', async () => {
      renderCreatorPage();

      fireEvent.click(screen.getByRole('button', { name: 'Open Campaign Frame' }));
      const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });
      fireEvent.click(within(reel).getByRole('link', { name: /Creator Name/ }));

      await waitFor(() => expect(queryReel()).not.toBeInTheDocument());
      expect(window.location.search).toBe('');

      window.history.back();
      expect(await screen.findByRole('dialog', { name: 'Creator reel viewer' })).toBeInTheDocument();
      expect(window.location.search).toBe('?post=item-1');
    }, 15_000);
  });

  it('closes a linked post on the first Close when an effect from before Close selects it again', async () => {
    window.history.replaceState(null, '', '/creators/creator-name?post=item-1');
    renderCreatorPage();

    const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });
    await pressCloseAsTheCountArrives(reel);

    await waitFor(() => expect(queryReel()).not.toBeInTheDocument());
    expect(window.location.search).toBe('');
  }, 15_000);

  it('closes a post opened from its tile on the first Close in the same slot', async () => {
    renderCreatorPage();

    fireEvent.click(screen.getByRole('button', { name: 'Open Campaign Frame' }));
    const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });
    expect(window.location.search).toBe('?post=item-1');
    // Close goes Back here, and the popstate after it clears the post the
    // effect selected again. jsdom goes Back in a later task, as a browser does.
    await pressCloseAsTheCountArrives(reel);

    await waitFor(() => {
      expect(queryReel()).not.toBeInTheDocument();
      expect(window.location.search).toBe('');
    });
  }, 15_000);

  it('closes an opened post with Back, opens it again with Forward, and closes it with Creator', async () => {
    renderCreatorPage();

    fireEvent.click(screen.getByRole('button', { name: 'Open Campaign Frame' }));
    await screen.findByRole('dialog', { name: 'Creator reel viewer' });

    window.history.back();
    await waitFor(() => {
      expect(queryReel()).not.toBeInTheDocument();
      expect(window.location.search).toBe('');
    });

    window.history.forward();
    const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });
    expect(window.location.search).toBe('?post=item-1');

    // Forward made it a linked post: Close takes `post` out of this entry.
    fireEvent.click(within(reel).getByRole('button', { name: 'Creator' }));
    await waitFor(() => expect(queryReel()).not.toBeInTheDocument());
    expect(window.location.search).toBe('');
  }, 15_000);
});
