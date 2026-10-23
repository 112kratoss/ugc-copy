import type { AnchorHTMLAttributes, HTMLAttributes, MouseEvent, ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreatorContentTabs } from '@/app/creators/[username]/CreatorContentTabs';
import { loadShowcaseReelViewer } from '@/app/showcase/showcase-reel-loader';
import type { CreatorProfilePageData } from '@/lib/creator-profile';
import { POST_COMMENTS_PAGE_SIZE, type PostComment, type PostCommentsPage } from '@/lib/post-comments-client';
import { createReelEntryState } from '@/lib/reel-history-entry';
import { navigateWithinPage } from './fixtures/address-bar-search-params';

// The creator page with the real reel and the real thread, for what the
// stand-in reel of `creator-content-tabs.test.tsx` cannot press: the reel's own
// Close button, the links in it to this creator's page, and a comment count
// that arrives while the reel is open.

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));
// The reel reads the credit fields too; one object, so no value changes from
// render to render.
const authState = vi.hoisted(() => ({
  session: null,
  user: null,
  credits: null,
  marketplaceSpendableCredits: null,
  updateCredits: () => {},
}));

vi.mock('next/navigation', async () => {
  const { useAddressBarSearchParams } = await import('./fixtures/address-bar-search-params');
  return {
    usePathname: () => '/creators/creator-name',
    useRouter: () => routerMock,
    useSearchParams: useAddressBarSearchParams,
  };
});

// Next's `<Link>`: a plain click navigates without a page load; a click that
// opens a new tab or downloads (`next/dist/client/app-dir/link.js`) is the
// browser's, and goes nowhere here. Every link these tests follow leads to the
// page that is open; one to another page fails the test rather than leave the
// page mounted under a changed address.
vi.mock('next/link', async () => {
  const { navigateWithinPage: navigate } = await import('./fixtures/address-bar-search-params');
  return {
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
          const leftToTheBrowser = event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
            || (props.target !== undefined && props.target !== '_self') || props.download !== undefined;
          if (leftToTheBrowser) return;
          if (new URL(href, window.location.href).pathname !== window.location.pathname) {
            throw new Error(`The link stand-in follows links to the page that is open only, not ${href}.`);
          }
          navigate(href);
        }}
      >
        {children}
      </a>
    ),
  };
});

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => authState,
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

// What the thread reads; a test that needs a comment in it says so.
let threadComments: PostComment[] = [];
const creatorsComment: PostComment = {
  id: 'comment-1',
  parentId: null,
  body: 'Shot on a phone, by the window.',
  status: 'active',
  createdAt: '2026-03-27T11:00:00.000Z',
  replyCount: 0,
  author: { id: 'creator-1', username: 'creator-name', displayName: 'Creator Name', avatarUrl: null },
};

function renderCreatorPage() {
  return render(<CreatorContentTabs initialData={initialData} profilePath="/creators/creator-name" />);
}

const REEL = '[role="dialog"][aria-label="Creator reel viewer"]';
const queryReel = () => screen.queryByRole('dialog', { name: 'Creator reel viewer' });

/** Counts the reel's dialog being put on the page from now on. */
function countReelInsertions() {
  let insertions = 0;
  const count = (records: MutationRecord[]) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches(REEL) || node.querySelector(REEL))) insertions += 1;
      }
    }
  };
  const observer = new MutationObserver(count);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    count(observer.takeRecords());
    observer.disconnect();
    return insertions;
  };
}

/**
 * Opens the thread and presses the reel's Close in the slot after the commit
 * that drew the count the thread read, before that commit's passive effects
 * have run. That commit also took the count into the page's list, so the
 * page's URL effect is among those effects, holding the URL from before Close:
 * it selects the post again after Close cleared it.
 *
 * jsdom leaves those effects for a later task (React flushes them on
 * `setImmediate`), and a mutation observer's callback, a microtask after the
 * commit, takes the slot every time. Chromium has not shown that order (its
 * commit ran those effects first); the page must close the reel whichever
 * comes first.
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
  try {
    fireEvent.click(await within(reel).findByRole('button', { name: 'Show comments on Campaign Frame (0)' }));
    await waitFor(() => {
      if (!pressed) throw new Error('The thread never drew "Hide comments on Campaign Frame (3)", so Close was not pressed.');
    });
  } finally {
    observer.disconnect();
  }
}

describe('CreatorContentTabs with the reel', () => {
  beforeAll(async () => {
    // The reel loads on demand (`next/dynamic`). Loaded here, the first test's
    // wait for its dialog is not also a wait for the import.
    await loadShowcaseReelViewer();
    // The reel scrolls its details to the top each time it opens, and an
    // opened thread into view; jsdom has no element scrolling.
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  });

  beforeEach(() => {
    window.history.replaceState(null, '', '/creators/creator-name');
    threadComments = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/showcase/posts/item-1/comments')) {
        return {
          ok: true,
          json: async () => ({
            postId: 'item-1',
            postCreatorId: 'creator-1',
            commentCount: 3,
            comments: threadComments,
            pageInfo: { hasMore: false, nextOffset: null, limit: POST_COMMENTS_PAGE_SIZE, offset: 0 },
          } satisfies PostCommentsPage),
        };
      }
      return { ok: true, json: async () => ({ success: true }) };
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // The reel's links to this creator, their name and their own comments, lead
  // to the page the reel is open on. Followed, such a link drew the page again
  // from the server (on a page entered with a query, back to its first posts
  // and its top), put an entry without the tab in history and could be
  // dropped by the reel's own address changes, and the reel stayed open over
  // it. The reel closes instead, as its Close does.
  describe("a link to this creator's page inside the reel", () => {
    it('closes a linked post as Close does, keeping the tab and adding no entry', async () => {
      window.history.replaceState(null, '', '/creators/creator-name?post=item-1');
      renderCreatorPage();
      const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });
      const entries = window.history.length;

      fireEvent.click(within(reel).getByRole('link', { name: /Creator Name/ }));

      await waitFor(() => expect(queryReel()).not.toBeInTheDocument());
      expect(window.location.search).toBe('');
      expect(window.location.hash).toBe('#creator-creations');
      expect(window.history.length).toBe(entries);
    }, 15_000);

    it('closes a post opened from its tile by going back to the grid, as Close does', async () => {
      renderCreatorPage();
      const entries = window.history.length;

      fireEvent.click(screen.getByRole('button', { name: 'Open Campaign Frame' }));
      const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });
      fireEvent.click(within(reel).getByRole('link', { name: /Creator Name/ }));

      await waitFor(() => {
        expect(queryReel()).not.toBeInTheDocument();
        expect(window.location.search).toBe('');
      });
      // Only the tile's entry, now ahead of this one: Forward opens the post again.
      expect(window.history.length).toBe(entries + 1);
      window.history.forward();
      expect(await screen.findByRole('dialog', { name: 'Creator reel viewer' })).toBeInTheDocument();
    }, 15_000);

    it("closes the reel from the creator's own comment", async () => {
      threadComments = [creatorsComment];
      window.history.replaceState(null, '', '/creators/creator-name?post=item-1');
      renderCreatorPage();
      const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });
      const entries = window.history.length;

      fireEvent.click(within(reel).getByRole('button', { name: 'Show comments on Campaign Frame (0)' }));
      fireEvent.click(await within(reel).findByRole('link', { name: '@creator-name' }));

      await waitFor(() => expect(queryReel()).not.toBeInTheDocument());
      expect(window.location.search).toBe('');
      expect(window.history.length).toBe(entries);
    }, 15_000);

    it('leaves a click that opens a new tab to the browser', async () => {
      window.history.replaceState(null, '', '/creators/creator-name?post=item-1');
      renderCreatorPage();
      const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });

      fireEvent.click(within(reel).getByRole('link', { name: /Creator Name/ }), { ctrlKey: true });

      expect(queryReel()).toBeInTheDocument();
      expect(window.location.search).toBe('?post=item-1');
    }, 15_000);
  });

  // Back and Forward close and open the reel through the page's popstate
  // listener; any other navigation that leaves the page without a post closes
  // it through the URL effect.
  it('closes when a navigation leaves the page without a post', async () => {
    window.history.replaceState(null, '', '/creators/creator-name?post=item-1');
    renderCreatorPage();
    await screen.findByRole('dialog', { name: 'Creator reel viewer' });

    act(() => {
      navigateWithinPage('/creators/creator-name');
    });

    await waitFor(() => expect(queryReel()).not.toBeInTheDocument());
  }, 15_000);

  it('closes a linked post on the first Close when an effect from before Close selects it again', async () => {
    window.history.replaceState(null, '', '/creators/creator-name?post=item-1');
    renderCreatorPage();
    const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });
    const reelInsertions = countReelInsertions();

    await pressCloseAsTheCountArrives(reel);

    await waitFor(() => expect(queryReel()).not.toBeInTheDocument());
    expect(window.location.search).toBe('');
    // Closed once, never drawn again on the way.
    expect(reelInsertions()).toBe(0);
  }, 15_000);

  it('closes a post opened from its tile on the first Close in the same slot', async () => {
    renderCreatorPage();

    fireEvent.click(screen.getByRole('button', { name: 'Open Campaign Frame' }));
    const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });
    expect(window.location.search).toBe('?post=item-1');
    const reelInsertions = countReelInsertions();
    // Close goes Back here, and the popstate after it clears the post the
    // effect selected again. jsdom goes Back in a later task, as a browser does.
    await pressCloseAsTheCountArrives(reel);

    await waitFor(() => {
      expect(queryReel()).not.toBeInTheDocument();
      expect(window.location.search).toBe('');
    });
    expect(reelInsertions()).toBe(0);
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

    // Forward reached the reel's own entry (`reel-history-entry.ts`), so Close goes Back
    // to the grid's, as from the tile. It took Forward for a linked post's and replaced
    // the reel's entry, which left the grid twice in history
    // (archive/web-reel-forward-history-2026-10-23).
    const back = vi.spyOn(window.history, 'back');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    fireEvent.click(within(reel).getByRole('button', { name: 'Creator' }));
    await waitFor(() => {
      expect(queryReel()).not.toBeInTheDocument();
      expect(window.location.search).toBe('');
    });
    expect(back).toHaveBeenCalledTimes(1);
    expect(replaceState).not.toHaveBeenCalled();
    // The reel's entry is ahead again: Forward opens the post once more.
    window.history.forward();
    expect(await screen.findByRole('dialog', { name: 'Creator reel viewer' })).toBeInTheDocument();
  }, 15_000);

  // Next post replaces the reel's entry, which stays the reel's own.
  it('goes Back after Forward from a reel that had moved on to another post', async () => {
    const secondItem = { ...item, id: 'item-2', title: 'Second Frame', generationId: 'gen-2' };
    render(<CreatorContentTabs initialData={{ ...initialData, items: [item, secondItem] }} profilePath="/creators/creator-name" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Campaign Frame' }));
    const opened = await screen.findByRole('dialog', { name: 'Creator reel viewer' });
    fireEvent.click(within(opened).getByRole('button', { name: 'Next post' }));
    await waitFor(() => expect(window.location.search).toBe('?post=item-2'));

    window.history.back();
    await waitFor(() => {
      expect(queryReel()).not.toBeInTheDocument();
      expect(window.location.search).toBe('');
    });
    window.history.forward();
    const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });
    expect(window.location.search).toBe('?post=item-2');

    // Stubbed: the dialog goes in the click itself, and a real Back would still be on its
    // way when the next test starts.
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    fireEvent.click(within(reel).getByRole('button', { name: 'Creator' }));
    await waitFor(() => expect(queryReel()).not.toBeInTheDocument());
    expect(back).toHaveBeenCalledTimes(1);
  }, 15_000);

  // The page mounts on the reel's own entry: a reload, or a Back from a page the reel
  // linked to ("Post details", a commenter's page), where the page mounts again.
  it('goes Back from a reel whose own entry the page mounted on', async () => {
    window.history.replaceState(createReelEntryState('post'), '', '/creators/creator-name?post=item-1');
    renderCreatorPage();
    const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });

    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const replaceState = vi.spyOn(window.history, 'replaceState');
    fireEvent.click(within(reel).getByRole('button', { name: 'Creator' }));
    await waitFor(() => expect(queryReel()).not.toBeInTheDocument());
    expect(back).toHaveBeenCalledTimes(1);
    expect(replaceState).not.toHaveBeenCalled();
  }, 15_000);

  // A linked post's entry (a shared link), and every entry from before the reel marked
  // its own: opened by address, so Close replaces it, also once Back has reached it.
  it('replaces the entry of a post Back reached on an entry the reel did not push', async () => {
    window.history.replaceState(null, '', '/creators/creator-name?post=item-1');
    window.history.pushState(null, '', '/creators/creator-name');
    renderCreatorPage();

    window.history.back();
    const reel = await screen.findByRole('dialog', { name: 'Creator reel viewer' });
    expect(window.location.search).toBe('?post=item-1');

    const back = vi.spyOn(window.history, 'back');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    fireEvent.click(within(reel).getByRole('button', { name: 'Creator' }));
    await waitFor(() => expect(queryReel()).not.toBeInTheDocument());
    expect(back).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/creators/creator-name#creator-creations');
  }, 15_000);
});
