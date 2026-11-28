import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import CreationsPage from '@/app/creations/page';
import FeedbackViewport from '@/components/FeedbackViewport';
import { resetFeedbackState } from '@/components/feedback-state';
import { forgetStudioReturnedPost, rememberStudioReturnedPost } from '@/lib/creations-workspace-cache';

const navigationState = vi.hoisted(() => {
  const push = vi.fn();
  return {
    push,
    router: { push },
    searchParams: new URLSearchParams(),
  };
});

const getSessionMock = vi.hoisted(() => vi.fn());
const temporaryUploadMock = vi.hoisted(() => vi.fn());
const authState = vi.hoisted(() => ({
  session: {
    access_token: 'layout-session-token',
    user: { id: 'user-1' },
  },
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/creations',
  useRouter: () => navigationState.router,
  useSearchParams: () => navigationState.searchParams,
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({
    session: authState.session,
  }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
    },
  },
}));

vi.mock('@/lib/temporary-media-upload', () => ({
  uploadMediaToTemporaryStorage: temporaryUploadMock,
}));

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, {
    get: (_target, tag: string) => {
      const MotionTag = ({ children, ...props }: React.HTMLAttributes<HTMLElement>) =>
        React.createElement(tag, props, children);

      MotionTag.displayName = `motion.${tag}`;
      return MotionTag;
    },
  }),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const jsonResponse = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

const GENERATIONS_PAGE_URL = '/api/generations?includeArchived=true&detail=summary&limit=36';
const NEXT_GENERATIONS_PAGE_URL = `${GENERATIONS_PAGE_URL}&cursor=36`;
const generationDetailUrl = (generationId: string) =>
  `/api/generations?includeArchived=true&id=${generationId}&limit=1`;

const makeGeneration = (overrides: Record<string, unknown> = {}) => ({
  id: 'gen-image',
  output_url: 'https://example.com/output.jpg',
  status: 'succeeded',
  created_at: '2026-06-01T10:00:00.000Z',
  completed_at: '2026-06-01T10:00:30.000Z',
  duration: 30,
  cost: 1,
  model: 'nano-banana-2',
  category: 'image',
  archived_at: null,
  ...overrides,
});

const makeSignedStorageUrl = (expiresAtSeconds: number, tokenId: string) => {
  const payload = Buffer.from(JSON.stringify({ exp: expiresAtSeconds, tokenId })).toString('base64url');
  return `https://project.supabase.co/storage/v1/object/sign/generated_images/user/output.jpg?token=header.${payload}.signature`;
};

const flushPromises = async () => {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
};

/** The shared contract's failed, refunded video (`listGenerations`, `failed-video-1`). */
const failedVideoFixture = mobileApiContract.endpoints.listGenerations.response.generations
  .find((generation) => generation.id === 'failed-video-1') as Record<string, unknown>;

/**
 * Answers the posts and profile reads the page always makes, and hands every
 * other request to `handle`; one it returns null for is unexpected.
 */
const stubStudioFetch = (
  handle: (url: string, init?: RequestInit) => Promise<Response> | null,
) => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const handled = handle(url, init);
    if (handled) {
      return handled;
    }
    if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
      return Promise.resolve(jsonResponse({ posts: [] }));
    }
    if (url === '/api/profile') {
      return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const firstPageReads = (fetchMock: ReturnType<typeof stubStudioFetch>) =>
  fetchMock.mock.calls.filter(([input]) => String(input) === GENERATIONS_PAGE_URL).length;

const chooseCardAction = async (title: string, action: string) => {
  fireEvent.click(await screen.findByRole('button', { name: `More actions for ${title}` }));
  const menu = await screen.findByRole('menu', { name: `More actions for ${title}` });
  fireEvent.click(within(menu).getByRole('menuitem', { name: action }));
};

describe('CreationsPage', () => {
  beforeEach(() => {
    navigationState.push.mockClear();
    navigationState.searchParams = new URLSearchParams();
    forgetStudioReturnedPost();
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });
    temporaryUploadMock.mockReset();
    temporaryUploadMock.mockResolvedValue({
      signedUrl: 'https://storage.example.test/signed/replacement.png',
      storagePath: 'uploads/user-1/replacement.png',
    });

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({ generations: [] }));
      }

      if (url.startsWith('/api/posts')) {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({
          username: 'creator-user1',
          displayName: 'Creator User',
          avatarUrl: 'https://cdn.example.com/avatar.jpg',
        }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetFeedbackState();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps the server render deterministic when session cache exists', () => {
    const withoutCache = renderToString(<CreationsPage />);

    window.sessionStorage.setItem('magicbooklet:creations-cache:v1:user-1', JSON.stringify({
      fetchedAt: Date.now(),
      generations: [
        makeGeneration({
          id: 'gen-cached-ssr',
          title: 'Cached SSR campaign',
        }),
      ],
      posts: [],
      profile: null,
    }));

    expect(renderToString(<CreationsPage />)).toBe(withoutCache);
  });

  // The section and filter live in the URL, so back, refresh, a shared link
  // and every returnTo land on what the viewer was looking at. The old tabs
  // set local state only, which is how the URL could say view=posts while
  // the Creations tab was highlighted.
  it('renders the sections as links that carry the view in the URL and mark the current one', async () => {
    navigationState.searchParams = new URLSearchParams('view=unlocks');
    render(<CreationsPage />);

    const sections = await screen.findByRole('navigation', { name: 'Studio sections' });
    const creations = within(sections).getByRole('link', { name: 'Creations' });
    const posts = within(sections).getByRole('link', { name: 'Post Library' });
    // One name for the buyer's library on both platforms (B-F9, glossary).
    const unlocks = within(sections).getByRole('link', { name: 'Unlocked recipes' });

    expect(creations).toHaveAttribute('href', '/creations');
    expect(posts).toHaveAttribute('href', '/creations?view=posts');
    expect(unlocks).toHaveAttribute('href', '/creations?view=unlocks');
    // Unlocks was not representable in the URL before.
    expect(unlocks).toHaveAttribute('aria-current', 'page');
    expect(creations).not.toHaveAttribute('aria-current');
    expect(posts).not.toHaveAttribute('aria-current');
    expect(screen.queryByRole('button', { name: 'Post Library' })).not.toBeInTheDocument();
    expect(screen.getByText('UNLOCKED RECIPES')).toBeInTheDocument();
  });

  // /profile has no setup mode any more (owner, 2026-11-09): an account with no
  // creator name chooses one at the name step, which comes back to Studio.
  it('sends Set up profile to the name step for an account with no creator name', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/generations')) return Promise.resolve(jsonResponse({ generations: [] }));
      if (url.startsWith('/api/posts')) return Promise.resolve(jsonResponse({ posts: [] }));
      if (url === '/api/profile') return Promise.resolve(jsonResponse({ username: 'creator-a1b2c3d4', displayName: '' }));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CreationsPage />);

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/profile')).toBe(true));
    const links = await screen.findAllByRole('link', { name: /set up profile/i });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/onboarding?next=%2Fcreations');
    }
  });

  it('keeps a named account’s profile links on its profile', async () => {
    render(<CreationsPage />);

    // The default profile has its name and handle.
    expect(await screen.findByRole('link', { name: /complete profile/i })).toHaveAttribute('href', '/profile?next=%2Fcreations');
    expect(screen.getByRole('link', { name: /set up profile/i })).toHaveAttribute('href', '/profile?next=%2Fcreations');
  });

  it('keeps the visibility filter in the URL and counts the current section in the header', async () => {
    navigationState.searchParams = new URLSearchParams('view=posts&visibility=private');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({ generations: [] }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        const basePost = {
          generationId: null,
          mediaUrl: null,
          mediaKind: null,
          description: '',
          prompt: '',
          body: 'Body',
          category: 'text',
          postFormat: 'text',
          sourceKind: 'manual',
          sourceTool: null,
          sourceLabel: 'Manual',
          createdAt: '2026-06-01T10:00:00.000Z',
          updatedAt: '2026-06-01T10:00:00.000Z',
          publicPath: null,
          resourcePath: null,
          canShare: false,
          bundle: null,
        };
        return Promise.resolve(jsonResponse({
          posts: [
            { ...basePost, id: 'post-a', title: 'Private one', visibility: 'private', archivedAt: null, ownerPath: '/post/post-a/edit' },
            { ...basePost, id: 'post-b', title: 'Public one', visibility: 'public', archivedAt: null, ownerPath: '/post/post-b/edit' },
            { ...basePost, id: 'post-c', title: 'Archived one', visibility: 'public', archivedAt: '2026-06-02T10:00:00.000Z', ownerPath: '/post/post-c/edit' },
          ],
        }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    render(<CreationsPage />);

    expect(await screen.findByText('Private one')).toBeInTheDocument();
    expect(screen.queryByText('Public one')).not.toBeInTheDocument();
    // Archived posts are their own list, not part of the active count.
    expect(screen.getByText('2 POSTS · 1 ARCHIVED')).toBeInTheDocument();

    const filters = screen.getByRole('group', { name: 'Filter posts by visibility' });
    expect(within(filters).getByRole('link', { name: 'All (2)' })).toHaveAttribute('href', '/creations?view=posts');
    expect(within(filters).getByRole('link', { name: 'Private (1)' })).toHaveAttribute('href', '/creations?view=posts&visibility=private');
    expect(within(filters).getByRole('link', { name: 'Private (1)' })).toHaveAttribute('aria-current', 'true');
    expect(within(filters).getByRole('link', { name: 'Archived (1)' })).toHaveAttribute('href', '/creations?view=posts&visibility=archived');
    expect(within(filters).getByRole('link', { name: 'Public (1)' })).not.toHaveAttribute('aria-current');
    // Unlisted was dropped on 2026-10-17 (decision 12): no chip for a state
    // no post is in.
    expect(within(filters).queryByRole('link', { name: /^Unlisted/ })).not.toBeInTheDocument();
  });

  it('keeps the Unlisted filter while a post saved as unlisted is left', async () => {
    navigationState.searchParams = new URLSearchParams('view=posts');
    stubStudioFetch((url) => {
      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({ generations: [] }));
      }
      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({
          posts: [{
            id: 'post-old',
            generationId: null,
            visibility: 'unlisted',
            archivedAt: null,
            mediaUrl: null,
            mediaKind: null,
            title: 'Old link post',
            description: '',
            prompt: '',
            body: 'Body',
            category: 'text',
            postFormat: 'text',
            sourceKind: 'manual',
            sourceTool: null,
            sourceLabel: 'Manual',
            createdAt: '2026-06-01T10:00:00.000Z',
            updatedAt: '2026-06-01T10:00:00.000Z',
            publicPath: null,
            ownerPath: '/post/post-old/edit',
            resourcePath: null,
            canShare: false,
            bundle: null,
          }],
        }));
      }
      return null;
    });

    render(<CreationsPage />);

    expect(await screen.findByText('Old link post')).toBeInTheDocument();
    const filters = screen.getByRole('group', { name: 'Filter posts by visibility' });
    expect(within(filters).getByRole('link', { name: 'Unlisted (1)' })).toHaveAttribute(
      'href',
      '/creations?view=posts&visibility=unlisted',
    );
  });

  it('uses the authenticated layout session for tab data instead of importing a fresh Supabase session', async () => {
    render(<CreationsPage />);

    expect(await screen.findByRole('heading', { name: /studio/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(GENERATIONS_PAGE_URL, {
        headers: { Authorization: 'Bearer layout-session-token' },
      });
    });

    expect(fetch).toHaveBeenCalledWith('/api/posts?scope=owner&includeArchived=true&limit=36&offset=0', {
      headers: { Authorization: 'Bearer layout-session-token' },
    });
    expect(fetch).toHaveBeenCalledWith('/api/profile', {
      headers: { Authorization: 'Bearer layout-session-token' },
    });
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('renders an explicit note for a creation whose only source is gone, with no loader or retry', async () => {
    const goneGeneration = makeGeneration({
      id: 'gen-gone',
      output_url: undefined,
      title: 'Expired clip',
      category: 'motion',
      media: null,
      source_unavailable_at: '2026-09-08T06:15:00.000Z',
    });

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({ generations: [goneGeneration] }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    render(<CreationsPage />);

    expect(await screen.findByText('Expired clip')).toBeInTheDocument();
    const note = await screen.findByTestId('creation-unavailable-gen-gone');
    expect(note).toHaveTextContent('This file is no longer available');
    expect(screen.queryByLabelText('Loading media')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /restore preview/i })).not.toBeInTheDocument();
  });

  it('opens the exact generation preview from a notification deep link', async () => {
    navigationState.searchParams = new URLSearchParams('generation=gen-notification');
    const notificationGeneration = makeGeneration({
      id: 'gen-notification',
      title: 'Notification image',
      prompt: 'A product image opened from an alert.',
      input_media: [],
      paywallPrefill: null,
    });

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({ generations: [] }));
      }

      if (url === generationDetailUrl('gen-notification')) {
        return Promise.resolve(jsonResponse({ generations: [notificationGeneration] }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    render(<CreationsPage />);

    expect(await screen.findByRole('dialog', { name: 'Notification image' })).toBeInTheDocument();
    expect(screen.getByAltText('Notification image')).toHaveAttribute(
      'src',
      'https://example.com/output.jpg'
    );
    expect(fetch).toHaveBeenCalledWith(generationDetailUrl('gen-notification'), {
      headers: { Authorization: 'Bearer layout-session-token' },
    });
  });

  // Review of #860: the details of a creation an alert opened went into the snapshot a return to
  // Studio draws first with the posts and the profile of the page's first render, none, beside the
  // up-to-date flag that said the posts were every post: "0 POSTS" until the refresh landed.
  it('saves the posts and the profile it holds with the details of the creation an alert opened', async () => {
    navigationState.searchParams = new URLSearchParams('generation=gen-notification');
    let answerDetails!: () => void;
    const detailsAnswered = new Promise<void>((resolve) => {
      answerDetails = resolve;
    });
    const posts = [
      { ...FIRST_POSTS_PAGE[0] },
      { ...FIRST_POSTS_PAGE[3] },
    ];
    stubStudioFetch((url) => {
      if (url === GENERATIONS_PAGE_URL) return Promise.resolve(jsonResponse({ generations: [] }));
      if (url === generationDetailUrl('gen-notification')) {
        return detailsAnswered.then(() => jsonResponse({
          generations: [makeGeneration({
            id: 'gen-notification',
            title: 'Notification image',
            prompt: 'A product image opened from an alert.',
            input_media: [],
            paywallPrefill: null,
          })],
        }));
      }
      if (url === POSTS_PAGE_URL) return Promise.resolve(jsonResponse({ posts }));
      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({
          username: 'creator-user1',
          stats: { creations: 1, posts: 1, archivedPosts: 1, saved: 0 },
        }));
      }
      return null;
    });
    const readSnapshot = () => JSON.parse(
      window.sessionStorage.getItem('magicbooklet:creations-cache:v1:user-1') ?? '{}',
    ) as {
      generations?: Array<{ id: string }>;
      posts?: Array<{ id: string }>;
      profile?: { stats?: Record<string, number> } | null;
      postsComplete?: boolean;
    };

    render(<CreationsPage />);

    // The page's own reads land first, while the details are on their way.
    await waitFor(() => expect(readSnapshot().postsComplete).toBe(true));
    await act(async () => {
      answerDetails();
    });
    expect(await screen.findByRole('dialog', { name: 'Notification image' })).toBeInTheDocument();

    const snapshot = readSnapshot();
    expect(snapshot.generations?.map((generation) => generation.id)).toEqual(['gen-notification']);
    expect(snapshot.posts?.map((post) => post.id)).toEqual(['a', 'd']);
    expect(snapshot.profile?.stats).toMatchObject({ posts: 1, archivedPosts: 1 });
    expect(snapshot.postsComplete).toBe(true);
  });

  // The preview's own Escape listens on the window; the Escape that answered
  // "Delete this creation?" used to close the preview behind it as well.
  it('keeps the preview open when Escape answers its delete question', async () => {
    navigationState.searchParams = new URLSearchParams('generation=gen-notification');
    const notificationGeneration = makeGeneration({
      id: 'gen-notification',
      title: 'Notification image',
      prompt: 'A product image opened from an alert.',
      input_media: [],
      paywallPrefill: null,
    });
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GENERATIONS_PAGE_URL) return Promise.resolve(jsonResponse({ generations: [] }));
      if (url === generationDetailUrl('gen-notification')) {
        return Promise.resolve(jsonResponse({ generations: [notificationGeneration] }));
      }
      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }
      if (url === '/api/profile') return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    render(<><CreationsPage /><FeedbackViewport /></>);

    const preview = await screen.findByRole('dialog', { name: 'Notification image' });
    fireEvent.click(within(preview).getByRole('button', { name: 'Delete creation' }));
    const question = await screen.findByRole('alertdialog', { name: 'Delete this creation?' });
    const cancel = within(question).getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());

    fireEvent.keyDown(cancel, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('dialog', { name: 'Notification image' })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });

  it('shows cached workspace content immediately while refreshing in the background', async () => {
    window.sessionStorage.setItem('magicbooklet:creations-cache:v1:user-1', JSON.stringify({
      fetchedAt: Date.now(),
      generations: [
        {
          id: 'gen-cached',
          output_url: 'https://example.com/cached.jpg',
          status: 'succeeded',
          created_at: '2026-05-01T10:00:00.000Z',
          completed_at: '2026-05-01T10:00:30.000Z',
          duration: 30,
          cost: 1,
          model: 'nano-banana-2',
          category: 'image',
          is_public: false,
          title: 'Cached Campaign',
          description: 'Loaded from cache before the network settles.',
          prompt: 'A cached creator shot.',
          archived_at: null,
        },
      ],
      posts: [],
      profile: {
        id: 'user-1',
        username: 'cached-creator',
        displayName: 'Cached Creator',
        bio: 'Fast loading workspace.',
        avatarUrl: 'https://example.com/avatar.jpg',
        coverUrl: 'https://example.com/cover.jpg',
      },
    }));
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));

    render(<CreationsPage />);

    expect(await screen.findByText('Cached Campaign')).toBeInTheDocument();
    expect(screen.queryByText(/Start your portfolio loop/i)).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(GENERATIONS_PAGE_URL, {
      headers: { Authorization: 'Bearer layout-session-token' },
    });
  });

  // A next page answered 200 with no list read as an empty last page: Load more went away for good
  // (review of the 2026-11-27 fix). It is a failed read, and Load more stays to try again.
  it('keeps Load more when the next page answers 200 with no list', async () => {
    stubStudioFetch((url) => {
      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [makeGeneration({ id: 'gen-picture-1', title: 'Picture one' })],
          pagination: { limit: 36, hasMore: true, nextCursor: '36' },
        }));
      }
      if (url === NEXT_GENERATIONS_PAGE_URL) {
        return Promise.resolve(new Response('<!DOCTYPE html><p>Busy</p>', { status: 200 }));
      }
      return null;
    });
    render(<CreationsPage />);
    expect(await screen.findByText('Picture one')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more creations/i }));

    expect(await screen.findByText('Failed to load more creations.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load more creations/i })).toBeInTheDocument();
    expect(screen.getByText('Picture one')).toBeInTheDocument();
  });

  // Live sweep of 2026-11-17: "54 CREATIONS TOTAL" over "All (29)" and "Images (29)", the filters
  // counting the one page of 36 loaded. The rule is getStudioCreationCounts (creation-workspace.ts);
  // studio-counts-and-first-screen.spec.ts draws the sweep's own numbers in a browser.
  it('says the same totals in the header and the media filters, and a number only where it is a total', async () => {
    stubStudioFetch((url) => {
      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({ id: 'gen-picture-1', title: 'Picture one' }),
            makeGeneration({ id: 'gen-picture-2', title: 'Picture two' }),
          ],
          pagination: { limit: 36, hasMore: true, nextCursor: '36' },
        }));
      }
      if (url === NEXT_GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({
              id: 'gen-clip-1',
              title: 'Clip one',
              category: 'video',
              model: 'veo3_fast',
              output_url: 'https://example.com/clip.mp4',
              created_at: '2026-05-31T10:00:00.000Z',
            }),
          ],
          pagination: { limit: 36, hasMore: false, nextCursor: null },
        }));
      }
      if (url === '/api/profile') {
        // owner_profile_counts: the library holds three finished creations.
        return Promise.resolve(jsonResponse({
          username: 'creator-user1',
          stats: { creations: 3, posts: 0, archivedPosts: 0, saved: 0 },
        }));
      }
      return null;
    });
    const filters = () => within(screen.getByRole('link', { name: /^All\b/ }).parentElement!)
      .getAllByRole('link')
      .map((link) => link.textContent);

    render(<CreationsPage />);

    expect(await screen.findByText('Picture one')).toBeInTheDocument();
    expect(await screen.findByText('3 CREATIONS TOTAL')).toBeInTheDocument();
    // The page loaded holds two pictures of the three: All says the library's three, Images no number.
    expect(filters()).toEqual(['All (3)', 'Images']);

    fireEvent.click(screen.getByRole('button', { name: /load more creations/i }));
    expect(await screen.findByText('Clip one')).toBeInTheDocument();

    // Every page loaded: each number is a total.
    expect(screen.getByText('3 CREATIONS TOTAL')).toBeInTheDocument();
    expect(filters()).toEqual(['All (3)', 'Images (2)', 'Videos (1)']);
    // And the snapshot a return to Studio draws first says so.
    const snapshot = JSON.parse(
      window.sessionStorage.getItem('magicbooklet:creations-cache:v1:user-1') ?? '{}',
    ) as { generationsComplete?: boolean };
    expect(snapshot.generationsComplete).toBe(true);
  });

  // Review of #836 (findings 3 and 4): before anything had answered the header read "0+ CREATIONS
  // TOTAL", and a return to Studio drew a whole library's media filters with no numbers until the
  // refresh landed, the snapshot not saying the library was whole.
  describe('before the refresh answers', () => {
    const studioFilters = () => within(screen.getByRole('link', { name: /^All\b/ }).parentElement!)
      .getAllByRole('link')
      .map((link) => link.textContent);
    const wholeLibrarySnapshot = (generationsComplete?: boolean) => JSON.stringify({
      fetchedAt: Date.now(),
      generations: [
        makeGeneration({ id: 'gen-picture-1', title: 'Picture one' }),
        makeGeneration({ id: 'gen-picture-2', title: 'Picture two' }),
        makeGeneration({ id: 'gen-clip-1', title: 'Clip one', category: 'video', model: 'veo3_fast', output_url: 'https://example.com/clip.mp4' }),
      ],
      posts: [],
      profile: { username: 'creator-user1', stats: { creations: 3, posts: 0, archivedPosts: 0, saved: 0 } },
      ...(generationsComplete === undefined ? {} : { generationsComplete }),
    });

    it('says no number while nothing has answered, never 0', async () => {
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));

      render(<CreationsPage />);

      const total = await screen.findByText(/CREATIONS TOTAL$/);
      // "—" to the eye, "Counting" to a screen reader.
      expect(within(total).getByText('—')).toHaveAttribute('aria-hidden', 'true');
      expect(within(total).getByText('Counting')).toHaveClass('sr-only');
      expect(total).toHaveTextContent(/^—Counting CREATIONS TOTAL$/);
      expect(screen.queryByText(/\d\+? CREATIONS TOTAL/)).not.toBeInTheDocument();
    });

    it("draws a whole library's filter totals from the snapshot at once", async () => {
      window.sessionStorage.setItem('magicbooklet:creations-cache:v1:user-1', wholeLibrarySnapshot(true));
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));

      render(<CreationsPage />);

      expect(await screen.findByText('Clip one')).toBeInTheDocument();
      expect(screen.getByText('3 CREATIONS TOTAL')).toBeInTheDocument();
      expect(studioFilters()).toEqual(['All (3)', 'Images (2)', 'Videos (1)']);
    });

    it('draws no kind number from a snapshot that does not say its library was whole', async () => {
      window.sessionStorage.setItem('magicbooklet:creations-cache:v1:user-1', wholeLibrarySnapshot());
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));

      render(<CreationsPage />);

      expect(await screen.findByText('Clip one')).toBeInTheDocument();
      expect(studioFilters()).toEqual(['All (3)', 'Images', 'Videos']);
    });
  });

  // Review of #836 (finding 1): with every page loaded, a creation of the second page archived
  // stayed active here, as the refresh rereads only the first page and keeps the later rows as
  // they were, and the header said 3 where the server, read in the same refresh, said 2.
  it('counts a creation of a later page out as soon as it is archived, with every page loaded', async () => {
    let creationsTotal = 3;
    const archivedIds = new Set<string>();
    stubStudioFetch((url, init) => {
      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({ id: 'gen-picture-1', title: 'Picture one' }),
            makeGeneration({ id: 'gen-picture-2', title: 'Picture two' }),
          ],
          pagination: { limit: 36, hasMore: true, nextCursor: '36' },
        }));
      }
      if (url === NEXT_GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [makeGeneration({
            id: 'gen-clip-1',
            title: 'Clip one',
            category: 'video',
            model: 'veo3_fast',
            output_url: 'https://example.com/clip.mp4',
            created_at: '2026-05-31T10:00:00.000Z',
            archived_at: archivedIds.has('gen-clip-1') ? '2026-06-02T10:00:00.000Z' : null,
          })],
          pagination: { limit: 36, hasMore: false, nextCursor: null },
        }));
      }
      if (url === '/api/generations/gen-clip-1/archive' && init?.method === 'POST') {
        archivedIds.add('gen-clip-1');
        creationsTotal = 2;
        return Promise.resolve(jsonResponse({ success: true, archived: true }));
      }
      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({
          username: 'creator-user1',
          stats: { creations: creationsTotal, posts: 0, archivedPosts: 0, saved: 0 },
        }));
      }
      return null;
    });
    const filters = () => within(screen.getByRole('link', { name: /^All\b/ }).parentElement!)
      .getAllByRole('link')
      .map((link) => link.textContent);

    render(<><CreationsPage /><FeedbackViewport /></>);

    expect(await screen.findByText('3 CREATIONS TOTAL')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more creations/i }));
    expect(await screen.findByText('Clip one')).toBeInTheDocument();
    expect(filters()).toEqual(['All (3)', 'Images (2)', 'Videos (1)']);

    await chooseCardAction('Clip one', 'Archive creation');
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Archive this creation?' }))
      .getByRole('button', { name: 'Archive' }));

    expect(await screen.findByText('2 CREATIONS TOTAL')).toBeInTheDocument();
    await waitFor(() => expect(filters()).toEqual(['All (2)', 'Images (2)']));
    expect(screen.queryByTestId('creation-card-gen-clip-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('archived-card-gen-clip-1')).toBeInTheDocument();
  });

  // Review of #836 (finding 1): the list's cursor counts rows, so after a delete with more pages
  // to load, Load more asked for the next page one row too far on and skipped a creation.
  it('asks for the next page a row earlier after a creation is deleted while more pages wait', async () => {
    const fetchMock = stubStudioFetch((url, init) => {
      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [makeGeneration({ id: 'gen-page-1', title: 'First page creation' })],
          pagination: { limit: 36, hasMore: true, nextCursor: '36' },
        }));
      }
      if (url === NEXT_GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [makeGeneration({ id: 'gen-page-2', title: 'Second page creation', created_at: '2026-05-31T10:00:00.000Z' })],
          pagination: { limit: 36, hasMore: true, nextCursor: '72' },
        }));
      }
      if (url === '/api/generations/gen-page-2' && init?.method === 'DELETE') {
        return Promise.resolve(jsonResponse({ success: true, deleted: true }));
      }
      if (url.startsWith(`${GENERATIONS_PAGE_URL}&cursor=7`)) {
        return Promise.resolve(jsonResponse({
          generations: [makeGeneration({ id: 'gen-page-3', title: 'Third page creation', created_at: '2026-05-30T10:00:00.000Z' })],
          pagination: { limit: 36, hasMore: false, nextCursor: null },
        }));
      }
      return null;
    });

    render(<><CreationsPage /><FeedbackViewport /></>);

    expect(await screen.findByText('First page creation')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more creations/i }));
    expect(await screen.findByText('Second page creation')).toBeInTheDocument();

    await chooseCardAction('Second page creation', 'Delete creation');
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Delete this creation?' }))
      .getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(firstPageReads(fetchMock)).toBe(2));
    await act(flushPromises);
    expect(screen.queryByText('Second page creation')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more creations/i }));
    expect(await screen.findByText('Third page creation')).toBeInTheDocument();
    const pageReads = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.startsWith(`${GENERATIONS_PAGE_URL}&cursor=`));
    expect(pageReads).toEqual([NEXT_GENERATIONS_PAGE_URL, `${GENERATIONS_PAGE_URL}&cursor=71`]);
  });

  // Review of #836, second round: a Load more under way set the cursor from its own answer after
  // a delete sent meanwhile had stepped it back, undoing the step, and the next page skipped a row.
  it('waits for a Load more under way before it sends a delete, so the next page still starts a row earlier', async () => {
    let answerSecondPage!: () => void;
    const secondPageAnswered = new Promise<void>((resolve) => {
      answerSecondPage = resolve;
    });
    let firstPage = [makeGeneration({ id: 'gen-page-1', title: 'First page creation' })];
    const fetchMock = stubStudioFetch((url, init) => {
      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: firstPage,
          pagination: { limit: 36, hasMore: true, nextCursor: '36' },
        }));
      }
      if (url === NEXT_GENERATIONS_PAGE_URL) {
        return secondPageAnswered.then(() => jsonResponse({
          generations: [makeGeneration({ id: 'gen-page-2', title: 'Second page creation', created_at: '2026-05-31T10:00:00.000Z' })],
          pagination: { limit: 36, hasMore: true, nextCursor: '72' },
        }));
      }
      if (url === '/api/generations/gen-page-1' && init?.method === 'DELETE') {
        firstPage = [];
        return Promise.resolve(jsonResponse({ success: true, deleted: true }));
      }
      if (url.startsWith(`${GENERATIONS_PAGE_URL}&cursor=7`)) {
        return Promise.resolve(jsonResponse({
          generations: [makeGeneration({ id: 'gen-page-3', title: 'Third page creation', created_at: '2026-05-30T10:00:00.000Z' })],
          pagination: { limit: 36, hasMore: false, nextCursor: null },
        }));
      }
      return null;
    });
    const deletesSent = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE').length;

    render(<><CreationsPage /><FeedbackViewport /></>);

    expect(await screen.findByText('First page creation')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more creations/i }));
    await chooseCardAction('First page creation', 'Delete creation');
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Delete this creation?' }))
      .getByRole('button', { name: 'Delete' }));
    await act(flushPromises);
    // Held until the page under way has landed.
    expect(deletesSent()).toBe(0);

    await act(async () => {
      answerSecondPage();
    });
    expect(await screen.findByText('Second page creation')).toBeInTheDocument();
    await waitFor(() => expect(deletesSent()).toBe(1));
    await waitFor(() => expect(firstPageReads(fetchMock)).toBe(2));
    await act(flushPromises);
    expect(screen.queryByText('First page creation')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more creations/i }));
    expect(await screen.findByText('Third page creation')).toBeInTheDocument();
    const pageReads = fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.startsWith(`${GENERATIONS_PAGE_URL}&cursor=`));
    expect(pageReads).toEqual([NEXT_GENERATIONS_PAGE_URL, `${GENERATIONS_PAGE_URL}&cursor=71`]);
  });

  it('holds Load more while a delete is under way', async () => {
    let answerDelete!: () => void;
    const deleteAnswered = new Promise<void>((resolve) => {
      answerDelete = resolve;
    });
    let firstPage = [
      makeGeneration({ id: 'gen-page-1', title: 'First page creation' }),
      makeGeneration({ id: 'gen-page-1b', title: 'Another first page creation' }),
    ];
    stubStudioFetch((url, init) => {
      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: firstPage,
          pagination: { limit: 36, hasMore: true, nextCursor: '36' },
        }));
      }
      if (url === '/api/generations/gen-page-1' && init?.method === 'DELETE') {
        return deleteAnswered.then(() => {
          firstPage = firstPage.slice(1);
          return jsonResponse({ success: true, deleted: true });
        });
      }
      return null;
    });
    const loadMore = () => screen.getByRole('button', { name: /load more creations/i });

    render(<><CreationsPage /><FeedbackViewport /></>);

    expect(await screen.findByText('First page creation')).toBeInTheDocument();
    expect(loadMore()).toBeEnabled();
    await chooseCardAction('First page creation', 'Delete creation');
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Delete this creation?' }))
      .getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(loadMore()).toBeDisabled());

    await act(async () => {
      answerDelete();
    });
    await waitFor(() => expect(loadMore()).toBeEnabled());
    expect(screen.queryByText('First page creation')).not.toBeInTheDocument();
  });

  // Review of #836, second round: with every page loaded, a delete, an archive or a restore changed
  // the list at once and the server total held here not, so the counts said the old total, with
  // no kind numbers, until the refresh landed, and for good when it failed.
  describe('the total it holds, moved by a change made here', () => {
    const library = [
      makeGeneration({ id: 'gen-picture-1', title: 'Picture one' }),
      makeGeneration({ id: 'gen-picture-2', title: 'Picture two' }),
      makeGeneration({
        id: 'gen-clip-1',
        title: 'Clip one',
        category: 'video',
        model: 'veo3_fast',
        output_url: 'https://example.com/clip.mp4',
        created_at: '2026-05-31T10:00:00.000Z',
      }),
    ];
    const studioFilters = () => within(screen.getByRole('link', { name: /^All\b/ }).parentElement!)
      .getAllByRole('link')
      .map((link) => link.textContent);
    /** A whole library of three, and a refresh that fails from the first change on. */
    const stubLibrary = () => {
      const state = { refreshFails: false };
      stubStudioFetch((url, init) => {
        if (url === GENERATIONS_PAGE_URL) {
          if (state.refreshFails) return Promise.reject(new TypeError('Failed to fetch'));
          return Promise.resolve(jsonResponse({
            generations: library,
            pagination: { limit: 36, hasMore: false, nextCursor: null },
          }));
        }
        if (url === '/api/generations/gen-clip-1' && init?.method === 'DELETE') {
          state.refreshFails = true;
          return Promise.resolve(jsonResponse({ success: true, deleted: true }));
        }
        if (url === '/api/generations/gen-clip-1/archive' && init?.method === 'POST') {
          state.refreshFails = true;
          return Promise.resolve(jsonResponse({ success: true, archived: true }));
        }
        if (url === '/api/generations/gen-clip-1/restore' && init?.method === 'POST') {
          return Promise.resolve(jsonResponse({ success: true, restored: true }));
        }
        if (url === '/api/profile') {
          return Promise.resolve(jsonResponse({
            username: 'creator-user1',
            stats: { creations: 3, posts: 0, archivedPosts: 0, saved: 0 },
          }));
        }
        return null;
      });
    };

    // A refresh answered 200 with a body that is not the list (a page the platform put in its
    // place) read as an empty object: the grid emptied and the library was marked complete
    // (review of the 2026-11-27 fix). It is a failed read: what is shown stays.
    it('keeps the grid and says the read failed when a refresh answers 200 with no list', async () => {
      const state = { unreadable: false };
      stubStudioFetch((url, init) => {
        if (url === GENERATIONS_PAGE_URL) {
          if (state.unreadable) return Promise.resolve(new Response('<!DOCTYPE html><p>Busy</p>', { status: 200 }));
          return Promise.resolve(jsonResponse({
            generations: library,
            pagination: { limit: 36, hasMore: false, nextCursor: null },
          }));
        }
        if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0' && state.unreadable) {
          return Promise.resolve(new Response('<!DOCTYPE html><p>Busy</p>', { status: 200 }));
        }
        if (url === '/api/generations/gen-clip-1' && init?.method === 'DELETE') {
          state.unreadable = true;
          return Promise.resolve(jsonResponse({ success: true, deleted: true }));
        }
        if (url === '/api/profile') {
          return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
        }
        return null;
      });
      render(<><CreationsPage /><FeedbackViewport /></>);
      expect(await screen.findByText('Picture one')).toBeInTheDocument();

      await chooseCardAction('Clip one', 'Delete creation');
      fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Delete this creation?' }))
        .getByRole('button', { name: 'Delete' }));

      expect(await screen.findByText('Could not load your creations. Check your connection and try again.')).toBeInTheDocument();
      expect(screen.getByText('Picture one')).toBeInTheDocument();
      expect(screen.getByText('Picture two')).toBeInTheDocument();
    });

    it('keeps the counts right after a delete when the refresh after it fails', async () => {
      stubLibrary();
      render(<><CreationsPage /><FeedbackViewport /></>);

      expect(await screen.findByText('3 CREATIONS TOTAL')).toBeInTheDocument();
      expect(studioFilters()).toEqual(['All (3)', 'Images (2)', 'Videos (1)']);

      await chooseCardAction('Clip one', 'Delete creation');
      fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Delete this creation?' }))
        .getByRole('button', { name: 'Delete' }));

      expect(await screen.findByText('2 CREATIONS TOTAL')).toBeInTheDocument();
      expect(studioFilters()).toEqual(['All (2)', 'Images (2)']);
      // The refresh failed, and the counts still agree with the grid.
      expect(await screen.findByText('Could not load your creations. Check your connection and try again.')).toBeInTheDocument();
      expect(screen.getByText('2 CREATIONS TOTAL')).toBeInTheDocument();
      expect(studioFilters()).toEqual(['All (2)', 'Images (2)']);
    });

    it('keeps the counts right after an archive and a restore when the refresh after them fails', async () => {
      stubLibrary();
      render(<><CreationsPage /><FeedbackViewport /></>);

      expect(await screen.findByText('3 CREATIONS TOTAL')).toBeInTheDocument();

      await chooseCardAction('Clip one', 'Archive creation');
      fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Archive this creation?' }))
        .getByRole('button', { name: 'Archive' }));
      expect(await screen.findByText('2 CREATIONS TOTAL')).toBeInTheDocument();
      expect(studioFilters()).toEqual(['All (2)', 'Images (2)']);

      fireEvent.click(within(screen.getByTestId('archived-card-gen-clip-1')).getByRole('button', { name: 'Restore' }));
      expect(await screen.findByText('3 CREATIONS TOTAL')).toBeInTheDocument();
      expect(studioFilters()).toEqual(['All (3)', 'Images (2)', 'Videos (1)']);
    });
  });

  // The owner's ask of 2026-11-17: each kind's number while pages remain, from owner_profile_counts'
  // `creationsByKind` (20261117192621), as the header's and All's come from its `creations`.
  describe("each kind's total while pages remain", () => {
    const studioFilters = () => within(screen.getByRole('link', { name: /^All\b/ }).parentElement!)
      .getAllByRole('link')
      .map((link) => link.textContent);
    /**
     * A library of 40 pictures, 12 clips and 2 sounds whose first page holds two pictures, and an
     * archive of the first that succeeds, after which every refresh fails: the counts then say
     * what this page moved them to.
     */
    const stubKindsLibrary = () => {
      const state = { refreshFails: false };
      stubStudioFetch((url, init) => {
        if (url === GENERATIONS_PAGE_URL) {
          if (state.refreshFails) return Promise.reject(new TypeError('Failed to fetch'));
          return Promise.resolve(jsonResponse({
            generations: [
              makeGeneration({ id: 'gen-picture-1', title: 'Picture one' }),
              makeGeneration({ id: 'gen-picture-2', title: 'Picture two' }),
            ],
            pagination: { limit: 36, hasMore: true, nextCursor: '36' },
          }));
        }
        if (url === '/api/generations/gen-picture-1/archive' && init?.method === 'POST') {
          state.refreshFails = true;
          return Promise.resolve(jsonResponse({ success: true, archived: true }));
        }
        if (url === '/api/profile') {
          return Promise.resolve(jsonResponse({
            username: 'creator-user1',
            stats: {
              creations: 54,
              creationsByKind: { images: 40, videos: 12, audio: 2 },
              posts: 0,
              archivedPosts: 0,
              saved: 0,
            },
          }));
        }
        return null;
      });
    };

    it("says each kind's total from the server while pages remain", async () => {
      stubKindsLibrary();
      render(<CreationsPage />);

      expect(await screen.findByText('Picture one')).toBeInTheDocument();
      expect(await screen.findByText('54 CREATIONS TOTAL')).toBeInTheDocument();
      // The page loaded holds two of the 40 pictures; a kind with nothing loaded is still no filter.
      expect(studioFilters()).toEqual(['All (54)', 'Images (40)']);
    });

    it('draws the chosen kind with its total though none of it is loaded yet', async () => {
      navigationState.searchParams = new URLSearchParams('media=videos');
      stubKindsLibrary();
      render(<CreationsPage />);

      expect(await screen.findByText('54 CREATIONS TOTAL')).toBeInTheDocument();
      expect(studioFilters()).toEqual(['All (54)', 'Images (40)', 'Videos (12)']);
    });

    it("moves a kind's total with a change made here", async () => {
      stubKindsLibrary();
      render(<><CreationsPage /><FeedbackViewport /></>);
      expect(await screen.findByText('54 CREATIONS TOTAL')).toBeInTheDocument();

      await chooseCardAction('Picture one', 'Archive creation');
      fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Archive this creation?' }))
        .getByRole('button', { name: 'Archive' }));

      expect(await screen.findByText('53 CREATIONS TOTAL')).toBeInTheDocument();
      expect(studioFilters()).toEqual(['All (53)', 'Images (39)']);
      // The refresh after it failed, and the split still adds up to the total.
      expect(await screen.findByText('Could not load your creations. Check your connection and try again.')).toBeInTheDocument();
      expect(studioFilters()).toEqual(['All (53)', 'Images (39)']);
    });
  });

  // The Post Library's pages: the owner list, every post archived or not, 36 a page by offset.
  const postsPageUrl = (offset: number) => `/api/posts?scope=owner&includeArchived=true&limit=36&offset=${offset}`;
  const POSTS_PAGE_URL = postsPageUrl(0);
  const NEXT_POSTS_PAGE_URL = postsPageUrl(36);
  const makePost = (
    id: string,
    visibility: 'public' | 'unlisted' | 'private',
    archivedAt: string | null = null,
  ) => ({
    id,
    generationId: null,
    visibility,
    archivedAt,
    mediaUrl: null,
    mediaKind: null,
    title: `Post ${id}`,
    description: '',
    prompt: '',
    body: 'Body',
    category: 'text',
    postFormat: 'text',
    sourceKind: 'manual',
    sourceTool: null,
    sourceLabel: 'Manual',
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    publicPath: null,
    ownerPath: `/post/${id}/edit`,
    resourcePath: null,
    canShare: false,
    bundle: null,
  });
  const ARCHIVED_AT = '2026-06-02T10:00:00.000Z';
  // A library of 5 posts (2 public, 1 unlisted, 2 private) and 2 archived, over two pages.
  const FIRST_POSTS_PAGE = [
    makePost('a', 'public'),
    makePost('b', 'public'),
    makePost('c', 'private'),
    makePost('d', 'public', ARCHIVED_AT),
  ];
  const SECOND_POSTS_PAGE = [
    makePost('e', 'unlisted'),
    makePost('f', 'private'),
    makePost('g', 'private', ARCHIVED_AT),
  ];

  // The Post Library had the fault #836 fixed in Creations: it loads its posts 36 at a time, and its
  // header and visibility filters counted the posts of the pages loaded so far. The rule is
  // getStudioPostCounts (creation-workspace.ts); studio-counts-and-first-screen.spec.ts draws it in
  // a browser.
  describe("the Post Library's counts", () => {
    const LIBRARY_STATS = { creations: 0, posts: 5, archivedPosts: 2, saved: 0 };
    const postFilters = () => within(screen.getByRole('group', { name: 'Filter posts by visibility' }))
      .getAllByRole('link')
      .map((link) => link.textContent);
    const readSnapshot = () => JSON.parse(
      window.sessionStorage.getItem('magicbooklet:creations-cache:v1:user-1') ?? '{}',
    ) as { postsComplete?: boolean; profile?: { stats?: typeof LIBRARY_STATS } };

    /**
     * The library's two pages, the server's totals (`stats`, by default without the visibility
     * split, as a database from before 20261117192621 counts them), and the post actions the
     * cases take: `archive` answers the archive of a (by default it succeeds), `deleted` a delete
     * of c or d, and a visibility change of b is stored as asked.
     */
    const stubPostLibrary = ({
      archive,
      deleted = { success: true },
      stats = LIBRARY_STATS,
    }: {
      archive?: Promise<Response>;
      deleted?: Record<string, unknown>;
      stats?: Record<string, unknown>;
    } = {}) => stubStudioFetch((url, init) => {
      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({ generations: [] }));
      }
      if (url === POSTS_PAGE_URL) {
        return Promise.resolve(jsonResponse({ posts: FIRST_POSTS_PAGE, pageInfo: { hasMore: true, nextOffset: 36 } }));
      }
      if (url === NEXT_POSTS_PAGE_URL) {
        return Promise.resolve(jsonResponse({ posts: SECOND_POSTS_PAGE, pageInfo: { hasMore: false, nextOffset: null } }));
      }
      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1', stats }));
      }
      if (url === '/api/posts/b' && init?.method === 'PUT') {
        const { visibility } = JSON.parse(String(init.body)) as { visibility: string };
        return Promise.resolve(jsonResponse({ success: true, visibility, postId: 'b' }));
      }
      if (url === '/api/posts/a/archive' && init?.method === 'POST') {
        return archive ?? Promise.resolve(jsonResponse({ success: true }));
      }
      if (url === '/api/posts/d/restore' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true }));
      }
      if ((url === '/api/posts/c' || url === '/api/posts/d') && init?.method === 'DELETE') {
        return Promise.resolve(jsonResponse(deleted));
      }
      return null;
    });

    it('says the same totals in the header and the visibility filters, and a number only where it is a total', async () => {
      navigationState.searchParams = new URLSearchParams('view=posts');
      stubPostLibrary();

      render(<CreationsPage />);

      expect(await screen.findByText('Post a')).toBeInTheDocument();
      // The page loaded holds 3 of the 5 posts and 1 of the 2 archived ones: it said "3 POSTS ·
      // 1 ARCHIVED" over "All (3)", "Public (2)", "Private (1)" and "Archived (1)".
      expect(await screen.findByText('5 POSTS · 2 ARCHIVED')).toBeInTheDocument();
      expect(postFilters()).toEqual(['All (5)', 'Public', 'Private', 'Archived (2)']);

      fireEvent.click(screen.getByRole('button', { name: 'Load more posts' }));
      expect(await screen.findByText('Post e')).toBeInTheDocument();

      // Every page loaded: each number is a total.
      expect(screen.getByText('5 POSTS · 2 ARCHIVED')).toBeInTheDocument();
      expect(postFilters()).toEqual(['All (5)', 'Public (2)', 'Unlisted (1)', 'Private (2)', 'Archived (2)']);
      // And the snapshot a return to Studio draws first says so.
      expect(readSnapshot().postsComplete).toBe(true);
    });

    it('says no number in the header while nothing has answered, never 0', async () => {
      navigationState.searchParams = new URLSearchParams('view=posts');
      vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));

      render(<CreationsPage />);

      const total = await screen.findByText(/POSTS$/);
      // "—" to the eye, "Counting" to a screen reader, as Creations says it.
      expect(within(total).getByText('—')).toHaveAttribute('aria-hidden', 'true');
      expect(within(total).getByText('Counting')).toHaveClass('sr-only');
      expect(total).toHaveTextContent(/^—Counting POSTS$/);
      expect(screen.queryByText(/\d\+? POSTS?\b/)).not.toBeInTheDocument();
    });

    it('says what is loaded with a "+" when the server could not count, and no filter a number', async () => {
      navigationState.searchParams = new URLSearchParams('view=posts');
      stubStudioFetch((url) => {
        if (url.startsWith('/api/generations')) return Promise.resolve(jsonResponse({ generations: [] }));
        if (url === POSTS_PAGE_URL) {
          return Promise.resolve(jsonResponse({ posts: FIRST_POSTS_PAGE, pageInfo: { hasMore: true, nextOffset: 36 } }));
        }
        if (url === '/api/profile') return Promise.resolve(jsonResponse({ error: 'Unavailable' }, { status: 503 }));
        return null;
      });

      render(<CreationsPage />);

      expect(await screen.findByText('Post a')).toBeInTheDocument();
      expect(await screen.findByText('3+ POSTS · 1+ ARCHIVED')).toBeInTheDocument();
      expect(postFilters()).toEqual(['All', 'Public', 'Private', 'Archived']);
    });

    // #860 left Public, Unlisted and Private without a number until every page was in, for want of
    // the server's split, which owner_profile_counts counts since 20261117192621.
    describe('with the visibilities the server counts', () => {
      const STATS_BY_VISIBILITY = { ...LIBRARY_STATS, postsByVisibility: { public: 2, unlisted: 1, private: 2 } };

      it("says each visibility's total while pages wait", async () => {
        navigationState.searchParams = new URLSearchParams('view=posts');
        stubPostLibrary({ stats: STATS_BY_VISIBILITY });

        render(<CreationsPage />);

        expect(await screen.findByText('Post a')).toBeInTheDocument();
        expect(await screen.findByText('5 POSTS · 2 ARCHIVED')).toBeInTheDocument();
        // Unlisted is a filter only while a post saved as one is loaded (getStudioPostFilters).
        expect(postFilters()).toEqual(['All (5)', 'Public (2)', 'Private (2)', 'Archived (2)']);

        fireEvent.click(screen.getByRole('button', { name: 'Load more posts' }));
        expect(await screen.findByText('Post e')).toBeInTheDocument();
        expect(postFilters()).toEqual(['All (5)', 'Public (2)', 'Unlisted (1)', 'Private (2)', 'Archived (2)']);
      });

      it("moves a visibility's total with a change made here while pages wait", async () => {
        navigationState.searchParams = new URLSearchParams('view=posts');
        stubPostLibrary({ stats: STATS_BY_VISIBILITY });
        render(<><CreationsPage /><FeedbackViewport /></>);
        expect(await screen.findByText('5 POSTS · 2 ARCHIVED')).toBeInTheDocument();

        await chooseCardAction('Post a', 'Archive post');
        fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Archive this post?' }))
          .getByRole('button', { name: 'Archive' }));
        expect(await screen.findByText('Post archived. Find it under Archived.')).toBeInTheDocument();
        expect(screen.getByText('4 POSTS · 3 ARCHIVED')).toBeInTheDocument();
        expect(postFilters()).toEqual(['All (4)', 'Public (1)', 'Private (2)', 'Archived (3)']);

        fireEvent.click(screen.getByRole('button', { name: 'Visibility of Post b: Public' }));
        const menu = await screen.findByRole('menu', { name: 'Visibility of Post b' });
        fireEvent.click(within(menu).getByRole('menuitemradio', { name: /private/i }));
        expect(await screen.findByText('Post is private.')).toBeInTheDocument();
        expect(screen.getByText('4 POSTS · 3 ARCHIVED')).toBeInTheDocument();
        expect(postFilters()).toEqual(['All (4)', 'Public (0)', 'Private (3)', 'Archived (3)']);
        // The snapshot a return to Studio draws first holds the moved split.
        expect(readSnapshot().profile?.stats).toMatchObject({
          posts: 4,
          archivedPosts: 3,
          postsByVisibility: { public: 0, unlisted: 1, private: 3 },
        });
      });

      // Review of #865: a creation card changes the visibility of its post, which the loaded pages
      // of the Post Library may not hold, and the split this page holds moved only for a loaded
      // post: Public and Private stayed a post apart from the server's until a refresh.
      describe("a creation card's post that the loaded pages do not hold", () => {
        const stubLinkedPost = (visibility?: Promise<Response>) => stubStudioFetch((url, init) => {
          if (url === GENERATIONS_PAGE_URL) {
            return Promise.resolve(jsonResponse({
              generations: [makeGeneration({
                id: 'gen-linked',
                title: 'Linked picture',
                linked_post_id: 'post-older',
                linked_post_title: 'Older post',
                linked_post_visibility: 'public',
                linked_post_archived_at: null,
              })],
              pagination: { limit: 36, hasMore: false, nextCursor: null },
            }));
          }
          if (url === POSTS_PAGE_URL) {
            // Two newer posts; the creation's own is on a page not loaded.
            return Promise.resolve(jsonResponse({
              posts: [makePost('a', 'public'), makePost('c', 'private')],
              pageInfo: { hasMore: true, nextOffset: 36 },
            }));
          }
          if (url === '/api/profile') {
            return Promise.resolve(jsonResponse({
              username: 'creator-user1',
              stats: { ...LIBRARY_STATS, creations: 1, postsByVisibility: { public: 3, unlisted: 0, private: 2 } },
            }));
          }
          if (url === '/api/posts/post-older' && init?.method === 'PUT') {
            return visibility ?? Promise.resolve(jsonResponse({ success: true, visibility: 'private', postId: 'post-older' }));
          }
          return null;
        });
        const makeOlderPostPrivate = async () => {
          fireEvent.click(await screen.findByRole('button', { name: 'Visibility of Older post: Public' }));
          const menu = await screen.findByRole('menu', { name: 'Visibility of Older post' });
          fireEvent.click(within(menu).getByRole('menuitemradio', { name: /private/i }));
        };

        it('moves the split from Public to Private, as the card reads the post', async () => {
          stubLinkedPost();
          const page = () => <><CreationsPage /><FeedbackViewport /></>;
          const { rerender } = render(page());
          expect(await screen.findByText('Linked picture')).toBeInTheDocument();

          await makeOlderPostPrivate();
          expect(await screen.findByText('Post is private.')).toBeInTheDocument();
          expect(readSnapshot().profile?.stats).toMatchObject({
            posts: 5,
            postsByVisibility: { public: 2, unlisted: 0, private: 3 },
          });

          navigationState.searchParams = new URLSearchParams('view=posts');
          rerender(page());
          expect(postFilters()).toEqual(['All (5)', 'Public (2)', 'Private (3)', 'Archived (2)']);
        });

        it('moves it back when the change fails', async () => {
          let failChange!: () => void;
          stubLinkedPost(new Promise<Response>((resolve) => {
            failChange = () => resolve(jsonResponse({ error: 'Could not change the post.' }, { status: 500 }));
          }));
          render(<><CreationsPage /><FeedbackViewport /></>);
          expect(await screen.findByText('Linked picture')).toBeInTheDocument();

          await makeOlderPostPrivate();
          // On its way: moved at once.
          await waitFor(() => expect(readSnapshot().profile?.stats).toMatchObject({
            postsByVisibility: { public: 2, unlisted: 0, private: 3 },
          }));

          await act(async () => {
            failChange();
          });
          expect(await screen.findByText('Could not change the post.')).toBeInTheDocument();
          expect(readSnapshot().profile?.stats).toMatchObject({
            posts: 5,
            postsByVisibility: { public: 3, unlisted: 0, private: 2 },
          });
        });
      });
    });

    describe('drawn from the snapshot before the refresh answers', () => {
      const snapshot = (postsComplete?: boolean) => JSON.stringify({
        fetchedAt: Date.now(),
        generations: [],
        posts: [...FIRST_POSTS_PAGE, ...SECOND_POSTS_PAGE],
        profile: { username: 'creator-user1', stats: LIBRARY_STATS },
        generationsComplete: true,
        ...(postsComplete === undefined ? {} : { postsComplete }),
      });

      it("draws a whole library's filter totals at once", async () => {
        navigationState.searchParams = new URLSearchParams('view=posts');
        window.sessionStorage.setItem('magicbooklet:creations-cache:v1:user-1', snapshot(true));
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));

        render(<CreationsPage />);

        expect(await screen.findByText('Post e')).toBeInTheDocument();
        expect(screen.getByText('5 POSTS · 2 ARCHIVED')).toBeInTheDocument();
        expect(postFilters()).toEqual(['All (5)', 'Public (2)', 'Unlisted (1)', 'Private (2)', 'Archived (2)']);
      });

      it('draws no visibility number from a snapshot that does not say its library was whole', async () => {
        navigationState.searchParams = new URLSearchParams('view=posts');
        window.sessionStorage.setItem('magicbooklet:creations-cache:v1:user-1', snapshot());
        vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));

        render(<CreationsPage />);

        expect(await screen.findByText('Post e')).toBeInTheDocument();
        expect(screen.getByText('5 POSTS · 2 ARCHIVED')).toBeInTheDocument();
        expect(postFilters()).toEqual(['All (5)', 'Public', 'Unlisted', 'Private', 'Archived (2)']);
      });
    });

    // As #836's second round found in Creations: the server's totals this page holds move with a
    // change made here, or with every page loaded they disagree with the list, and the counts,
    // which believe the server, said the old totals with no visibility numbers. Post actions do
    // not refresh the page, so they said them until the next visit.
    describe('the totals it holds, moved by a change made here', () => {
      /** Loads the second page, and waits for one of its posts the filter in view shows. */
      const loadEveryPage = async (shownFromSecondPage = 'Post e') => {
        expect(await screen.findByText('5 POSTS · 2 ARCHIVED')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Load more posts' }));
        expect(await screen.findByText(shownFromSecondPage)).toBeInTheDocument();
        expect(postFilters()).toEqual(['All (5)', 'Public (2)', 'Unlisted (1)', 'Private (2)', 'Archived (2)']);
      };

      it('moves a post archived here from one total to the other while the archive is on its way, and back when it fails', async () => {
        navigationState.searchParams = new URLSearchParams('view=posts');
        let failArchive!: () => void;
        const archive = new Promise<Response>((resolve) => {
          failArchive = () => resolve(jsonResponse({ error: 'Could not archive the post.' }, { status: 500 }));
        });
        stubPostLibrary({ archive });
        render(<><CreationsPage /><FeedbackViewport /></>);
        await loadEveryPage();

        await chooseCardAction('Post a', 'Archive post');
        fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Archive this post?' }))
          .getByRole('button', { name: 'Archive' }));

        // On its way: archived here at once, and its totals with it.
        expect(await screen.findByText('4 POSTS · 3 ARCHIVED')).toBeInTheDocument();
        expect(postFilters()).toEqual(['All (4)', 'Public (1)', 'Unlisted (1)', 'Private (2)', 'Archived (3)']);
        expect(readSnapshot().profile?.stats).toMatchObject({ posts: 4, archivedPosts: 3 });

        await act(async () => {
          failArchive();
        });

        // The archive failed: the post and the totals are back where they were.
        expect(await screen.findByText('Could not archive the post.')).toBeInTheDocument();
        expect(screen.getByText('5 POSTS · 2 ARCHIVED')).toBeInTheDocument();
        expect(postFilters()).toEqual(['All (5)', 'Public (2)', 'Unlisted (1)', 'Private (2)', 'Archived (2)']);
        expect(readSnapshot().profile?.stats).toMatchObject({ posts: 5, archivedPosts: 2 });
      });

      // A post with buyers stays on the server, archived (post-delete-service.ts), and leaves the list
      // here: it leaves its total with it, so the counts say what the list shows, and the next
      // refresh, which lists it under Archived, counts it there.
      it('takes a post its buyers keep out of the list and out of its total', async () => {
        navigationState.searchParams = new URLSearchParams('view=posts');
        stubPostLibrary({ deleted: { success: true, tombstoned: true } });
        render(<><CreationsPage /><FeedbackViewport /></>);
        await loadEveryPage();

        await chooseCardAction('Post c', 'Delete post');
        fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Delete this post permanently?' }))
          .getByRole('button', { name: 'Delete' }));

        expect(await screen.findByText('Post deleted. Buyers keep access to its recipe.')).toBeInTheDocument();
        expect(screen.queryByText('Post c')).not.toBeInTheDocument();
        expect(screen.getByText('4 POSTS · 2 ARCHIVED')).toBeInTheDocument();
        expect(postFilters()).toEqual(['All (4)', 'Public (2)', 'Unlisted (1)', 'Private (1)', 'Archived (2)']);
      });

      it('takes an archived post deleted here out of the archived total', async () => {
        navigationState.searchParams = new URLSearchParams('view=posts&visibility=archived');
        stubPostLibrary();
        render(<><CreationsPage /><FeedbackViewport /></>);
        await loadEveryPage('Post g');

        await chooseCardAction('Post d', 'Delete post');
        fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Delete this post permanently?' }))
          .getByRole('button', { name: 'Delete' }));

        expect(await screen.findByText('Post deleted.')).toBeInTheDocument();
        expect(screen.queryByText('Post d')).not.toBeInTheDocument();
        expect(screen.getByText('5 POSTS · 1 ARCHIVED')).toBeInTheDocument();
        expect(postFilters()).toEqual(['All (5)', 'Public (2)', 'Unlisted (1)', 'Private (2)', 'Archived (1)']);
      });

      it('keeps the counts right after an archive, a restore and a delete', async () => {
        navigationState.searchParams = new URLSearchParams('view=posts');
        stubPostLibrary();
        // A new element each time: React keeps one it was given before as it was, address and all.
        const page = () => <><CreationsPage /><FeedbackViewport /></>;
        const { rerender } = render(page());
        await loadEveryPage();

        await chooseCardAction('Post a', 'Archive post');
        fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Archive this post?' }))
          .getByRole('button', { name: 'Archive' }));
        expect(await screen.findByText('Post archived. Find it under Archived.')).toBeInTheDocument();
        expect(screen.getByText('4 POSTS · 3 ARCHIVED')).toBeInTheDocument();
        expect(postFilters()).toEqual(['All (4)', 'Public (1)', 'Unlisted (1)', 'Private (2)', 'Archived (3)']);
        // The snapshot a return to Studio draws first holds the moved totals.
        expect(readSnapshot().profile?.stats).toMatchObject({ posts: 4, archivedPosts: 3 });

        // An archived post is restored from the Archived filter's list.
        navigationState.searchParams = new URLSearchParams('view=posts&visibility=archived');
        rerender(page());
        await chooseCardAction('Post d', 'Restore post');
        expect(await screen.findByText('Post restored.')).toBeInTheDocument();
        expect(screen.getByText('5 POSTS · 2 ARCHIVED')).toBeInTheDocument();
        expect(postFilters()).toEqual(['All (5)', 'Public (2)', 'Unlisted (1)', 'Private (2)', 'Archived (2)']);

        navigationState.searchParams = new URLSearchParams('view=posts');
        rerender(page());
        await chooseCardAction('Post c', 'Delete post');
        fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Delete this post permanently?' }))
          .getByRole('button', { name: 'Delete' }));
        expect(await screen.findByText('Post deleted.')).toBeInTheDocument();
        expect(screen.getByText('4 POSTS · 2 ARCHIVED')).toBeInTheDocument();
        expect(postFilters()).toEqual(['All (4)', 'Public (2)', 'Unlisted (1)', 'Private (1)', 'Archived (2)']);
      });
    });
  });

  // The Post Library's next page is asked for by offset, the place of its first post in the owner
  // list, which holds every post, archived ones too, newest first. A delete takes its post out of
  // that list and moves every later one up a place, so Load more asked a place too far on and
  // skipped the post that moved up into the next page's first place. As #836 for Creations' cursor.
  describe("the Post Library's next page", () => {
    const postsPageReads = (fetchMock: ReturnType<typeof stubStudioFetch>) => fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.startsWith('/api/posts?'));
    const deletePost = async (title: string) => {
      await chooseCardAction(title, 'Delete post');
      fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Delete this post permanently?' }))
        .getByRole('button', { name: 'Delete' }));
    };
    const loadMore = () => screen.getByRole('button', { name: 'Load more posts' });

    it('asks for the next page a place earlier after a post is deleted while more pages wait', async () => {
      navigationState.searchParams = new URLSearchParams('view=posts');
      const fetchMock = stubStudioFetch((url, init) => {
        if (url.startsWith('/api/generations')) return Promise.resolve(jsonResponse({ generations: [] }));
        if (url === POSTS_PAGE_URL) {
          return Promise.resolve(jsonResponse({ posts: FIRST_POSTS_PAGE, pageInfo: { hasMore: true, nextOffset: 36 } }));
        }
        if (url === '/api/posts/c' && init?.method === 'DELETE') return Promise.resolve(jsonResponse({ success: true }));
        if (url.startsWith(postsPageUrl(3))) {
          return Promise.resolve(jsonResponse({ posts: SECOND_POSTS_PAGE, pageInfo: { hasMore: false, nextOffset: null } }));
        }
        return null;
      });

      render(<><CreationsPage /><FeedbackViewport /></>);

      expect(await screen.findByText('Post c')).toBeInTheDocument();
      await deletePost('Post c');
      expect(await screen.findByText('Post deleted.')).toBeInTheDocument();
      await waitFor(() => expect(loadMore()).toBeEnabled());

      fireEvent.click(loadMore());
      expect(await screen.findByText('Post e')).toBeInTheDocument();
      expect(postsPageReads(fetchMock)).toEqual([POSTS_PAGE_URL, postsPageUrl(35)]);
    });

    // A Load more under way sets the offset when its page lands, after a delete's step back, which
    // it would undo, so a delete cannot start meanwhile: Delete waits, and says so. Archive and
    // Restore move no post and stay open. Review of #860: the delete waited for the page before its
    // question, so a press showed nothing, and presses made meanwhile opened their questions when
    // it landed, each closing the one before (feedback-state.ts holds one question).
    it('holds Delete while a Load more is under way, so the next page still starts a place earlier', async () => {
      navigationState.searchParams = new URLSearchParams('view=posts');
      let answerSecondPage!: () => void;
      const secondPageAnswered = new Promise<void>((resolve) => {
        answerSecondPage = resolve;
      });
      const fetchMock = stubStudioFetch((url, init) => {
        if (url.startsWith('/api/generations')) return Promise.resolve(jsonResponse({ generations: [] }));
        if (url === POSTS_PAGE_URL) {
          return Promise.resolve(jsonResponse({ posts: FIRST_POSTS_PAGE, pageInfo: { hasMore: true, nextOffset: 36 } }));
        }
        if (url === NEXT_POSTS_PAGE_URL) {
          return secondPageAnswered.then(() => jsonResponse({
            posts: SECOND_POSTS_PAGE,
            pageInfo: { hasMore: true, nextOffset: 72 },
          }));
        }
        if (url === '/api/posts/a' && init?.method === 'DELETE') return Promise.resolve(jsonResponse({ success: true }));
        if (url.startsWith(postsPageUrl(7))) {
          return Promise.resolve(jsonResponse({ posts: [makePost('h', 'public')], pageInfo: { hasMore: false, nextOffset: null } }));
        }
        return null;
      });

      render(<><CreationsPage /><FeedbackViewport /></>);

      expect(await screen.findByText('Post a')).toBeInTheDocument();
      fireEvent.click(loadMore());
      fireEvent.click(screen.getByRole('button', { name: 'More actions for Post a' }));
      const menu = await screen.findByRole('menu', { name: 'More actions for Post a' });
      const heldDelete = within(menu).getByRole('menuitem', { name: /^Delete post/ });
      expect(heldDelete).toBeDisabled();
      expect(heldDelete).toHaveTextContent('Waiting for more posts to load');
      expect(within(menu).getByRole('menuitem', { name: 'Archive post' })).toBeEnabled();
      fireEvent.keyDown(menu, { key: 'Escape' });
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

      await act(async () => {
        answerSecondPage();
      });
      expect(await screen.findByText('Post e')).toBeInTheDocument();
      await deletePost('Post a');
      expect(await screen.findByText('Post deleted.')).toBeInTheDocument();
      await waitFor(() => expect(loadMore()).toBeEnabled());

      fireEvent.click(loadMore());
      expect(await screen.findByText('Post h')).toBeInTheDocument();
      expect(postsPageReads(fetchMock)).toEqual([POSTS_PAGE_URL, NEXT_POSTS_PAGE_URL, postsPageUrl(71)]);
    });

    // Review of #860: a page that landed after a refresh had reread the first page was added to
    // that page, after a gap: the pages loaded before were gone, none was asked for again, and with
    // the last page in Load more went. The 30-second check that refreshes Studio when a running
    // creation finishes is what lands so; Refresh now stands in for it here.
    it('drops a page that lands after a refresh reread the first page, and goes on from the refreshed one', async () => {
      navigationState.searchParams = new URLSearchParams('view=posts');
      let answerThirdPage!: () => void;
      const thirdPageAnswered = new Promise<void>((resolve) => {
        answerThirdPage = resolve;
      });
      const running = makeGeneration({
        id: 'gen-running',
        title: 'Running creation',
        status: 'processing',
        output_url: null,
        completed_at: null,
      });
      const fetchMock = stubStudioFetch((url) => {
        if (url.startsWith('/api/generations')) return Promise.resolve(jsonResponse({ generations: [running] }));
        if (url === POSTS_PAGE_URL) {
          return Promise.resolve(jsonResponse({ posts: FIRST_POSTS_PAGE, pageInfo: { hasMore: true, nextOffset: 36 } }));
        }
        if (url === NEXT_POSTS_PAGE_URL) {
          return Promise.resolve(jsonResponse({ posts: SECOND_POSTS_PAGE, pageInfo: { hasMore: true, nextOffset: 72 } }));
        }
        if (url === postsPageUrl(72)) {
          return thirdPageAnswered.then(() => jsonResponse({
            posts: [makePost('h', 'public')],
            pageInfo: { hasMore: false, nextOffset: null },
          }));
        }
        return null;
      });
      // A new element each time: React keeps one it was given before as it was, address and all.
      const page = () => <CreationsPage />;
      const { rerender } = render(page());

      expect(await screen.findByText('Post a')).toBeInTheDocument();
      fireEvent.click(loadMore());
      expect(await screen.findByText('Post e')).toBeInTheDocument();
      // The third page is on its way when Studio refreshes, from Creations.
      fireEvent.click(loadMore());
      navigationState.searchParams = new URLSearchParams();
      rerender(page());
      fireEvent.click(await screen.findByRole('button', { name: 'Refresh now' }));
      await waitFor(() => expect(postsPageReads(fetchMock).filter((url) => url === POSTS_PAGE_URL)).toHaveLength(2));
      await act(flushPromises);

      await act(async () => {
        answerThirdPage();
      });
      await act(flushPromises);
      navigationState.searchParams = new URLSearchParams('view=posts');
      rerender(page());

      // The refreshed first page, and no page after a gap: Load more goes on from it.
      expect(await screen.findByText('Post a')).toBeInTheDocument();
      expect(screen.queryByText('Post h')).not.toBeInTheDocument();
      expect(screen.queryByText('Post e')).not.toBeInTheDocument();
      await waitFor(() => expect(loadMore()).toBeEnabled());
      fireEvent.click(loadMore());
      expect(await screen.findByText('Post e')).toBeInTheDocument();
      expect(postsPageReads(fetchMock)).toEqual([
        POSTS_PAGE_URL,
        NEXT_POSTS_PAGE_URL,
        postsPageUrl(72),
        POSTS_PAGE_URL,
        NEXT_POSTS_PAGE_URL,
      ]);
    });

    it('holds Load more while a delete is under way', async () => {
      navigationState.searchParams = new URLSearchParams('view=posts');
      let answerDelete!: () => void;
      const deleteAnswered = new Promise<void>((resolve) => {
        answerDelete = resolve;
      });
      stubStudioFetch((url, init) => {
        if (url.startsWith('/api/generations')) return Promise.resolve(jsonResponse({ generations: [] }));
        if (url === POSTS_PAGE_URL) {
          return Promise.resolve(jsonResponse({ posts: FIRST_POSTS_PAGE, pageInfo: { hasMore: true, nextOffset: 36 } }));
        }
        if (url === '/api/posts/a' && init?.method === 'DELETE') {
          return deleteAnswered.then(() => jsonResponse({ success: true }));
        }
        return null;
      });

      render(<><CreationsPage /><FeedbackViewport /></>);

      expect(await screen.findByText('Post a')).toBeInTheDocument();
      expect(loadMore()).toBeEnabled();
      await deletePost('Post a');
      await waitFor(() => expect(loadMore()).toBeDisabled());

      await act(async () => {
        answerDelete();
      });
      expect(await screen.findByText('Post deleted.')).toBeInTheDocument();
      await waitFor(() => expect(loadMore()).toBeEnabled());
      expect(screen.queryByText('Post a')).not.toBeInTheDocument();
    });

    // The owner list keeps an archived post where it was, and a post with buyers too, archived, when
    // its creator deletes it (post-delete-service.ts): none of these moves a later post.
    it('starts the next page where it was after an archive, a restore, and a delete that keeps a post for its buyers', async () => {
      navigationState.searchParams = new URLSearchParams('view=posts');
      const fetchMock = stubStudioFetch((url, init) => {
        if (url.startsWith('/api/generations')) return Promise.resolve(jsonResponse({ generations: [] }));
        if (url === POSTS_PAGE_URL) {
          return Promise.resolve(jsonResponse({ posts: FIRST_POSTS_PAGE, pageInfo: { hasMore: true, nextOffset: 36 } }));
        }
        if (url === '/api/posts/a/archive' && init?.method === 'POST') return Promise.resolve(jsonResponse({ success: true }));
        if (url === '/api/posts/d/restore' && init?.method === 'POST') return Promise.resolve(jsonResponse({ success: true }));
        if (url === '/api/posts/b' && init?.method === 'DELETE') {
          return Promise.resolve(jsonResponse({ success: true, tombstoned: true }));
        }
        if (url.startsWith(postsPageUrl(3))) {
          return Promise.resolve(jsonResponse({ posts: SECOND_POSTS_PAGE, pageInfo: { hasMore: false, nextOffset: null } }));
        }
        return null;
      });
      // A new element each time: React keeps one it was given before as it was, address and all.
      const page = () => <><CreationsPage /><FeedbackViewport /></>;
      const { rerender } = render(page());

      expect(await screen.findByText('Post a')).toBeInTheDocument();
      await chooseCardAction('Post a', 'Archive post');
      fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Archive this post?' }))
        .getByRole('button', { name: 'Archive' }));
      expect(await screen.findByText('Post archived. Find it under Archived.')).toBeInTheDocument();

      navigationState.searchParams = new URLSearchParams('view=posts&visibility=archived');
      rerender(page());
      await chooseCardAction('Post d', 'Restore post');
      expect(await screen.findByText('Post restored.')).toBeInTheDocument();

      navigationState.searchParams = new URLSearchParams('view=posts');
      rerender(page());
      await deletePost('Post b');
      expect(await screen.findByText('Post deleted. Buyers keep access to its recipe.')).toBeInTheDocument();
      await waitFor(() => expect(loadMore()).toBeEnabled());

      fireEvent.click(loadMore());
      expect(await screen.findByText('Post e')).toBeInTheDocument();
      expect(postsPageReads(fetchMock)).toEqual([POSTS_PAGE_URL, NEXT_POSTS_PAGE_URL]);
    });
  });

  it('loads the next creations page without refetching the whole history', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({
              id: 'gen-first-page',
              title: 'First page creation',
            }),
          ],
          pagination: {
            limit: 36,
            hasMore: true,
            nextCursor: '36',
          },
        }));
      }

      if (url === NEXT_GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({
              id: 'gen-second-page',
              title: 'Second page creation',
              created_at: '2026-05-31T10:00:00.000Z',
            }),
          ],
          pagination: {
            limit: 36,
            hasMore: false,
            nextCursor: null,
          },
        }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CreationsPage />);

    expect(await screen.findByText('First page creation')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more creations/i }));

    expect(await screen.findByText('Second page creation')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more creations/i })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(GENERATIONS_PAGE_URL, {
      headers: { Authorization: 'Bearer layout-session-token' },
    });
    expect(fetchMock).toHaveBeenCalledWith(NEXT_GENERATIONS_PAGE_URL, {
      headers: { Authorization: 'Bearer layout-session-token' },
    });
  });

  it('lets generation-backed public posts move private from Post Library in one click', async () => {
    navigationState.searchParams = new URLSearchParams('view=posts');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({ generations: [] }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({
          posts: [
            {
              id: 'post-public',
              generationId: 'gen-public',
              visibility: 'public',
              archivedAt: null,
              mediaUrl: null,
              mediaKind: null,
              title: 'Public portrait post',
              description: 'A public generated post.',
              prompt: 'Portrait prompt',
              body: '',
              category: 'image',
              postFormat: 'text',
              sourceKind: 'magicbooklet',
              sourceTool: 'magicbooklet',
              sourceLabel: 'magicbooklet',
              createdAt: '2026-06-01T10:00:00.000Z',
              updatedAt: '2026-06-01T10:00:00.000Z',
              publicPath: '/showcase/post-public',
              ownerPath: '/post/post-public/edit',
              resourcePath: null,
              canShare: true,
              bundle: null,
            },
          ],
        }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      if (url === '/api/posts/post-public') {
        return Promise.resolve(jsonResponse({
          success: true,
          visibility: 'private',
          postId: 'post-public',
        }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<><CreationsPage /><FeedbackViewport /></>);

    expect(await screen.findByText('Public portrait post')).toBeInTheDocument();
    // One control with the two states (decision 12, 2026-10-17); it reads the current one.
    const trigger = screen.getByRole('button', { name: 'Visibility of Public portrait post: Public' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'Visibility of Public portrait post' });
    expect(within(menu).getByRole('menuitemradio', { name: /public/i })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(2);
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /private/i }));

    // The card moves before the server answers, and the All filter keeps it.
    expect(screen.getByRole('button', { name: 'Visibility of Public portrait post: Private' })).toBeInTheDocument();

    // The post route, for a generation-backed post too: it moves the
    // creation's media itself, and it is the door the mobile app uses.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-public', expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: 'Bearer layout-session-token',
        }),
        body: JSON.stringify({ visibility: 'private' }),
      }));
    });
    expect(fetchMock).not.toHaveBeenCalledWith('/api/showcase/publish', expect.anything());
    expect(await screen.findByRole('status')).toHaveTextContent('Post is private.');
    // No workspace reload: the change landed in local state.
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith('/api/posts?')).length).toBe(1);
    expect(screen.getByRole('button', { name: 'Visibility of Public portrait post: Private' })).toBeInTheDocument();
  });

  it('rolls a visibility change back and reports the server error when the request fails', async () => {
    navigationState.searchParams = new URLSearchParams('view=posts');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({ generations: [] }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({
          posts: [
            {
              id: 'post-upload',
              generationId: null,
              visibility: 'private',
              archivedAt: null,
              mediaUrl: 'https://example.com/upload.jpg',
              mediaKind: 'image',
              title: 'Uploaded private post',
              description: '',
              prompt: '',
              body: '',
              category: 'image',
              postFormat: 'media',
              sourceKind: 'external',
              sourceTool: 'Midjourney',
              sourceLabel: 'Midjourney',
              createdAt: '2026-06-01T10:00:00.000Z',
              updatedAt: '2026-06-01T10:00:00.000Z',
              publicPath: null,
              ownerPath: '/post/post-upload/edit',
              resourcePath: null,
              canShare: false,
              bundle: null,
            },
          ],
        }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      if (url === '/api/posts/post-upload') {
        return Promise.resolve(jsonResponse(
          { success: false, error: 'Complete your profile before publishing publicly.' },
          { status: 400 },
        ));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<><CreationsPage /><FeedbackViewport /></>);

    expect(await screen.findByText('Uploaded private post')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Visibility of Uploaded private post: Private' }));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: /public/i }));

    // An uploaded post goes through the post route, not the generation publish route.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-upload', expect.objectContaining({ method: 'PUT' }));
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Complete your profile before publishing publicly.');
    expect(screen.getByRole('button', { name: 'Visibility of Uploaded private post: Private' })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/showcase/publish', expect.anything());
  });

  // As the app's (owner, 2026-10-31): Publish opens the full composer for the
  // creation, not a pop-up, and the composer's Back returns to this view.
  it('opens the full composer from a creation’s Publish, on its card and in its details', async () => {
    const creation = makeGeneration({ id: 'gen-fresh', title: 'Fresh portrait' });
    const fetchMock = stubStudioFetch((url) => (
      url === GENERATIONS_PAGE_URL || url === generationDetailUrl('gen-fresh')
        ? Promise.resolve(jsonResponse({ generations: [creation] }))
        : null
    ));

    render(<CreationsPage />);

    const composerHref = '/post/new?generationId=gen-fresh&from=creations&returnTo=%2Fcreations';
    const card = await screen.findByTestId('creation-card-gen-fresh');
    expect(within(card).getByRole('link', { name: 'Publish' })).toHaveAttribute('href', composerHref);

    fireEvent.click(within(card).getByRole('button', { name: 'Details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Fresh portrait' });
    expect(within(dialog).getByRole('link', { name: 'Publish' })).toHaveAttribute('href', composerHref);
    // Publish is the way to the composer, so the details offer no second one.
    expect(within(dialog).queryByRole('link', { name: 'Customize post' })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/showcase/publish', expect.anything());
  });

  // Back pressed with a creation's details open left Studio for the page before (owner,
  // 2026-11-15). The details are an entry of the browser's history now, as a reel opened from a
  // tile is (the browser's half: tests/e2e/studio-preview-back.spec.ts).
  describe("the details in the browser's history", () => {
    afterEach(() => {
      window.history.replaceState(null, '', '/');
    });

    async function openFreshDetails() {
      const creation = makeGeneration({ id: 'gen-fresh', title: 'Fresh portrait' });
      stubStudioFetch((url) => (
        url === GENERATIONS_PAGE_URL || url === generationDetailUrl('gen-fresh')
          ? Promise.resolve(jsonResponse({ generations: [creation] }))
          : null
      ));
      window.history.replaceState(null, '', '/creations?media=images');
      render(<CreationsPage />);
      fireEvent.click(within(await screen.findByTestId('creation-card-gen-fresh')).getByRole('button', { name: 'Details' }));
      return screen.findByRole('dialog', { name: 'Fresh portrait' });
    }

    it("push an entry naming the creation, and Close goes Back to Studio's own", async () => {
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      const dialog = await openFreshDetails();

      expect(`${window.location.pathname}${window.location.search}`).toBe('/creations?media=images&generation=gen-fresh');
      expect(window.history.state).toMatchObject({ reelPushedFor: 'generation' });

      fireEvent.click(within(dialog).getByRole('button', { name: 'Close preview' }));

      expect(back).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog', { name: 'Fresh portrait' })).not.toBeInTheDocument();
    });

    it("close when Back reaches Studio's own entry", async () => {
      await openFreshDetails();

      act(() => {
        window.history.replaceState(null, '', '/creations?media=images');
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      });

      expect(screen.queryByRole('dialog', { name: 'Fresh portrait' })).not.toBeInTheDocument();
    });

    // Review of #819: a load that ended after a later press opened its details too, and pushed a
    // second entry, so Close brought the first details back.
    it('open only the last pressed creation when two loads are out', async () => {
      const first = makeGeneration({ id: 'gen-first', title: 'First portrait', created_at: '2026-06-02T10:00:00.000Z' });
      const second = makeGeneration({ id: 'gen-second', title: 'Second portrait' });
      const answers = new Map<string, (response: Response) => void>();
      stubStudioFetch((url) => {
        if (url === GENERATIONS_PAGE_URL) return Promise.resolve(jsonResponse({ generations: [first, second] }));
        if (url === generationDetailUrl('gen-first') || url === generationDetailUrl('gen-second')) {
          return new Promise<Response>((resolve) => answers.set(url, resolve));
        }
        return null;
      });
      window.history.replaceState(null, '', '/creations');
      const push = vi.spyOn(window.history, 'pushState');
      render(<CreationsPage />);

      fireEvent.click(within(await screen.findByTestId('creation-card-gen-first')).getByRole('button', { name: 'Details' }));
      fireEvent.click(within(screen.getByTestId('creation-card-gen-second')).getByRole('button', { name: 'Details' }));
      await act(async () => {
        answers.get(generationDetailUrl('gen-second'))?.(jsonResponse({ generations: [{ ...second, input_media: [] }] }));
      });
      await act(async () => {
        answers.get(generationDetailUrl('gen-first'))?.(jsonResponse({ generations: [{ ...first, input_media: [] }] }));
      });

      expect(await screen.findByRole('dialog', { name: 'Second portrait' })).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: 'First portrait' })).not.toBeInTheDocument();
      expect(push).toHaveBeenCalledTimes(1);
      expect(window.location.search).toBe('?generation=gen-second');
    });

    // Review of #819: Forward onto the entry of a creation deleted here read it again, and the page
    // said its details were not found.
    it('take a deleted creation out of the address when Forward reaches its entry', async () => {
      vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      const creation = makeGeneration({ id: 'gen-fresh', title: 'Fresh portrait' });
      const fetchMock = stubStudioFetch((url, init) => {
        if (url === GENERATIONS_PAGE_URL) return Promise.resolve(jsonResponse({ generations: [creation] }));
        if (url === generationDetailUrl('gen-fresh')) return Promise.resolve(jsonResponse({ generations: [{ ...creation, input_media: [] }] }));
        if (url === '/api/generations/gen-fresh' && init?.method === 'DELETE') return Promise.resolve(jsonResponse({ success: true }));
        return null;
      });
      window.history.replaceState(null, '', '/creations');
      render(<><CreationsPage /><FeedbackViewport /></>);
      fireEvent.click(within(await screen.findByTestId('creation-card-gen-fresh')).getByRole('button', { name: 'Details' }));
      const dialog = await screen.findByRole('dialog', { name: 'Fresh portrait' });

      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete creation' }));
      fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Delete this creation?' })).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Fresh portrait' })).not.toBeInTheDocument());

      const reads = fetchMock.mock.calls.filter(([input]) => String(input) === generationDetailUrl('gen-fresh')).length;
      act(() => {
        window.history.replaceState(null, '', '/creations?generation=gen-fresh');
        window.dispatchEvent(new PopStateEvent('popstate', { state: { reelPushedFor: 'generation' } }));
      });

      expect(`${window.location.pathname}${window.location.search}`).toBe('/creations');
      expect(screen.queryByRole('dialog', { name: 'Fresh portrait' })).not.toBeInTheDocument();
      expect(fetchMock.mock.calls.filter(([input]) => String(input) === generationDetailUrl('gen-fresh'))).toHaveLength(reads);
    });

    // A link's creation, closed, opens again when a link names it once more: the address's read
    // starts over once the address names none.
    it('open a creation a link names again after its details were closed', async () => {
      navigationState.searchParams = new URLSearchParams('generation=gen-notification');
      window.history.replaceState(null, '', '/creations?generation=gen-notification');
      const notificationGeneration = makeGeneration({
        id: 'gen-notification',
        title: 'Notification image',
        input_media: [],
        paywallPrefill: null,
      });
      stubStudioFetch((url) => {
        if (url === GENERATIONS_PAGE_URL) return Promise.resolve(jsonResponse({ generations: [] }));
        if (url === generationDetailUrl('gen-notification')) {
          return Promise.resolve(jsonResponse({ generations: [notificationGeneration] }));
        }
        return null;
      });
      const view = render(<CreationsPage />);
      fireEvent.click(within(await screen.findByRole('dialog', { name: 'Notification image' })).getByRole('button', { name: 'Close preview' }));
      expect(screen.queryByRole('dialog', { name: 'Notification image' })).not.toBeInTheDocument();

      // The router reads the address without the creation, then a link names it again.
      navigationState.searchParams = new URLSearchParams();
      view.rerender(<CreationsPage />);
      navigationState.searchParams = new URLSearchParams('generation=gen-notification');
      window.history.replaceState(null, '', '/creations?generation=gen-notification');
      view.rerender(<CreationsPage />);

      expect(await screen.findByRole('dialog', { name: 'Notification image' })).toBeInTheDocument();
    });

    it('take a creation the address opened out of the address in place on Close', async () => {
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
      navigationState.searchParams = new URLSearchParams('generation=gen-notification');
      window.history.replaceState(null, '', '/creations?generation=gen-notification');
      const notificationGeneration = makeGeneration({
        id: 'gen-notification',
        title: 'Notification image',
        input_media: [],
        paywallPrefill: null,
      });
      stubStudioFetch((url) => {
        if (url === GENERATIONS_PAGE_URL) return Promise.resolve(jsonResponse({ generations: [] }));
        if (url === generationDetailUrl('gen-notification')) {
          return Promise.resolve(jsonResponse({ generations: [notificationGeneration] }));
        }
        return null;
      });
      render(<CreationsPage />);

      const dialog = await screen.findByRole('dialog', { name: 'Notification image' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close preview' }));

      expect(`${window.location.pathname}${window.location.search}`).toBe('/creations');
      expect(back).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: 'Notification image' })).not.toBeInTheDocument();
    });
  });

  // Publishing the creation again would rebuild a recipe from the generation
  // prefill and replace whatever the editor saved. An existing post's recipe
  // is always edited in the editor, which loads the stored bundle.
  it('links a generated card Add recipe action to the post editor', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({
              id: 'gen-linked',
              title: 'Linked generated post',
              linked_post_id: 'post-linked',
              linked_post_title: 'Linked generated post',
              linked_post_visibility: 'public',
              linked_post_archived_at: null,
            }),
          ],
        }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CreationsPage />);

    // Its way back names the view it was opened from, as Publish's does.
    const addRecipeLink = await screen.findByRole('link', { name: /^add recipe$/i });
    expect(addRecipeLink).toHaveAttribute(
      'href',
      '/post/post-linked/edit?recipe=add&from=creations&returnTo=%2Fcreations#recipe',
    );
    expect(screen.queryByRole('button', { name: /^add recipe$/i })).not.toBeInTheDocument();
    // No detail fetch: the link needs nothing beyond the linked post id.
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/generations?includeArchived=true&id=gen-linked&limit=1',
      expect.anything(),
    );
  });

  it('links a Post Library Manage recipe action to the post editor for a generation-backed post', async () => {
    navigationState.searchParams = new URLSearchParams('view=posts&visibility=public');
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({
              id: 'gen-bundled',
              title: 'Bundled generated post',
            }),
          ],
        }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({
          posts: [
            {
              id: 'post-bundled',
              generationId: 'gen-bundled',
              visibility: 'public',
              archivedAt: null,
              mediaUrl: 'https://example.com/post.jpg',
              mediaKind: 'image',
              title: 'Bundled generated post',
              description: 'A bundled generated post.',
              prompt: 'Portrait prompt',
              body: '',
              category: 'image',
              postFormat: 'media',
              sourceKind: 'magicbooklet',
              sourceTool: 'magicbooklet',
              sourceLabel: 'magicbooklet',
              createdAt: '2026-06-01T10:00:00.000Z',
              updatedAt: '2026-06-01T10:00:00.000Z',
              publicPath: '/showcase/post-bundled',
              ownerPath: '/post/post-bundled/edit',
              resourcePath: '/showcase/post-bundled#recipe',
              canShare: true,
              bundle: {
                id: 'bundle-1',
                accessMode: 'free',
                status: 'published',
                priceUsdCents: 0,
                salesCount: 0,
                earningsUsdCents: 0,
                resourceKinds: ['prompt', 'notes', 'remix'],
              },
            },
            {
              id: 'post-uploaded',
              generationId: null,
              visibility: 'public',
              archivedAt: null,
              mediaUrl: 'https://example.com/upload.jpg',
              mediaKind: 'image',
              title: 'Uploaded post without a recipe',
              description: '',
              prompt: '',
              body: '',
              category: 'image',
              postFormat: 'media',
              sourceKind: 'external',
              sourceTool: 'Midjourney',
              sourceLabel: 'Midjourney',
              createdAt: '2026-06-01T09:00:00.000Z',
              updatedAt: '2026-06-01T09:00:00.000Z',
              publicPath: '/showcase/post-uploaded',
              ownerPath: '/post/post-uploaded/edit',
              resourcePath: null,
              canShare: true,
              bundle: null,
            },
          ],
        }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({
          username: 'creator-user1',
          displayName: 'Creator User',
          avatarUrl: 'https://cdn.example.com/avatar.jpg',
        }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CreationsPage />);

    // The stored recipe is free; the editor link carries that so it opens on
    // the saved access mode rather than a Paid default. Its way back is the
    // view and the filter it was opened from: a save goes back there.
    const manageRecipeLink = await screen.findByRole('link', { name: /^manage recipe$/i });
    expect(manageRecipeLink).toHaveAttribute(
      'href',
      '/post/post-bundled/edit?resourceMode=free&focus=price&from=creations&returnTo=%2Fcreations%3Fview%3Dposts%26visibility%3Dpublic#recipe',
    );
    expect(screen.queryByRole('button', { name: /^manage recipe$/i })).not.toBeInTheDocument();

    // An uploaded post with no recipe gets the same entry point.
    expect(screen.getByRole('link', { name: /^add recipe$/i })).toHaveAttribute(
      'href',
      '/post/post-uploaded/edit?recipe=add&from=creations&returnTo=%2Fcreations%3Fview%3Dposts%26visibility%3Dpublic#recipe',
    );
    expect(navigationState.push).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/showcase/publish', expect.anything());
  });

  describe('back from a saved edit', () => {
    const POSTS_PAGE_URL = '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0';
    const ownerPost = (id: string, title: string) => ({
      id,
      generationId: null,
      visibility: 'private',
      archivedAt: null,
      mediaUrl: null,
      mediaKind: null,
      title,
      description: '',
      prompt: '',
      body: `${title}, as a text post.`,
      category: 'text',
      postFormat: 'text',
      sourceKind: 'manual',
      sourceTool: null,
      sourceLabel: null,
      createdAt: '2026-06-01T10:00:00.000Z',
      updatedAt: '2026-06-01T10:00:00.000Z',
      publicPath: null,
      ownerPath: `/post/${id}/edit`,
      resourcePath: null,
      canShare: false,
      bundle: null,
    });

    // The editor names the post it has just saved on its way back here: its
    // card is ringed and brought into view, as an alert's run is, and only on
    // that return.
    it('rings and brings into view the post an edit has just saved, once', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      navigationState.searchParams = new URLSearchParams('view=posts&visibility=private');
      const scrollIntoView = vi.fn();
      const ownScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
      Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView });
      stubStudioFetch((url) => (
        url === GENERATIONS_PAGE_URL
          ? Promise.resolve(jsonResponse({ generations: [] }))
          : url === POSTS_PAGE_URL
            ? Promise.resolve(jsonResponse({
              posts: [ownerPost('post-other', 'Another post'), ownerPost('post-saved', 'The saved post')],
            }))
            : null
      ));
      rememberStudioReturnedPost('post-saved');

      try {
        const { unmount } = render(<CreationsPage />);

        const card = await screen.findByTestId('post-card-post-saved');
        expect(card).toHaveAttribute('data-highlighted', 'true');
        expect(screen.getByTestId('post-card-post-other')).not.toHaveAttribute('data-highlighted');
        await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
        expect(scrollIntoView.mock.contexts[0]).toBe(card);

        await act(async () => {
          vi.advanceTimersByTime(4000);
        });
        expect(card).not.toHaveAttribute('data-highlighted');

        // Studio drawn again later rings nothing.
        unmount();
        render(<CreationsPage />);
        expect(await screen.findByTestId('post-card-post-saved')).not.toHaveAttribute('data-highlighted');
        expect(scrollIntoView).toHaveBeenCalledTimes(1);
      } finally {
        if (ownScrollIntoView) {
          Object.defineProperty(Element.prototype, 'scrollIntoView', ownScrollIntoView);
        } else {
          delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
        }
      }
    });

    // Creations, where Manage recipe sits on the creation's own card.
    it('rings the creation whose post an edit has just saved', async () => {
      stubStudioFetch((url) => (
        url === GENERATIONS_PAGE_URL
          ? Promise.resolve(jsonResponse({
            generations: [
              makeGeneration({ id: 'gen-unlinked', title: 'A creation with no post' }),
              makeGeneration({
                id: 'gen-linked',
                title: 'Linked generated post',
                linked_post_id: 'post-linked',
                linked_post_title: 'Linked generated post',
                linked_post_visibility: 'private',
                linked_post_archived_at: null,
              }),
            ],
          }))
          : null
      ));
      rememberStudioReturnedPost('post-linked');

      render(<CreationsPage />);

      expect(await screen.findByTestId('creation-card-gen-linked')).toHaveAttribute('data-highlighted', 'true');
      expect(screen.getByTestId('creation-card-gen-unlinked')).not.toHaveAttribute('data-highlighted');
    });

    // A private post opens in its editor, which goes back to this view once
    // saved, as every other editor link here does (#930's review).
    it('opens a private post’s editor from its creation with the way back to Studio', async () => {
      stubStudioFetch((url) => (
        url === GENERATIONS_PAGE_URL
          ? Promise.resolve(jsonResponse({
            generations: [makeGeneration({
              id: 'gen-linked',
              title: 'Linked generated post',
              linked_post_id: 'post-linked',
              linked_post_title: 'Linked generated post',
              linked_post_visibility: 'private',
              linked_post_archived_at: null,
            })],
          }))
          : null
      ));

      render(<CreationsPage />);

      const card = await screen.findByTestId('creation-card-gen-linked');
      const openPost = within(card).getByRole('link', { name: /open post|linked generated post/i });
      const href = new URL(openPost.getAttribute('href') ?? '', 'https://magicbooklet.com');
      expect(href.pathname).toBe('/post/post-linked/edit');
      expect(href.searchParams.get('from')).toBe('creations');
      expect(href.searchParams.get('returnTo')).toBe('/creations');
    });
  });

  // A recipe taken off while people had it is retired: they keep it, but the
  // post has none, as the editor and Recipe sales read it. Studio drew it as
  // a draft with Manage recipe, whose link reopened the editor on its old mode.
  describe('a recipe taken off while people have it', () => {
    const POSTS_PAGE_URL = '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0';
    const postWithRetiredRecipe = {
      id: 'post-retired',
      generationId: 'gen-retired',
      visibility: 'public',
      archivedAt: null,
      mediaUrl: null,
      mediaKind: null,
      title: 'A post whose recipe was taken off',
      description: '',
      prompt: '',
      body: 'Its recipe was taken off after three people unlocked it.',
      category: 'text',
      postFormat: 'text',
      sourceKind: 'magicbooklet',
      sourceTool: 'magicbooklet',
      sourceLabel: 'magicbooklet',
      createdAt: '2026-06-01T10:00:00.000Z',
      updatedAt: '2026-06-01T10:00:00.000Z',
      publicPath: '/showcase/post-retired',
      ownerPath: '/post/post-retired/edit',
      resourcePath: '/showcase/post-retired#recipe',
      canShare: true,
      bundle: {
        id: 'bundle-retired',
        accessMode: 'free',
        status: 'draft',
        priceUsdCents: 0,
        salesCount: 0,
        freeUnlockCount: 3,
        earningsUsdCents: 0,
        resourceKinds: ['prompt', 'notes'],
        retiredAt: '2026-11-03T00:00:00.000Z',
      },
    };

    it('shows the post with no recipe, and Add recipe, in Post Library', async () => {
      navigationState.searchParams = new URLSearchParams('view=posts');
      stubStudioFetch((url) => (
        url === GENERATIONS_PAGE_URL
          ? Promise.resolve(jsonResponse({ generations: [] }))
          : url === POSTS_PAGE_URL
            ? Promise.resolve(jsonResponse({ posts: [postWithRetiredRecipe] }))
            : null
      ));

      render(<CreationsPage />);

      const card = await screen.findByTestId('post-card-post-retired');
      expect(within(card).getByRole('link', { name: /^add recipe$/i })).toHaveAttribute(
        'href',
        '/post/post-retired/edit?recipe=add&from=creations&returnTo=%2Fcreations%3Fview%3Dposts#recipe',
      );
      expect(within(card).queryByRole('link', { name: /^manage recipe$/i })).not.toBeInTheDocument();
      expect(within(card).queryByText('Recipe draft')).not.toBeInTheDocument();
      expect(within(card).getByText('No recipe')).toBeInTheDocument();
    });

    it('offers Add recipe on the creation the post was made from', async () => {
      stubStudioFetch((url) => (
        url === GENERATIONS_PAGE_URL
          ? Promise.resolve(jsonResponse({
            generations: [makeGeneration({
              id: 'gen-retired',
              title: 'A post whose recipe was taken off',
              linked_post_id: 'post-retired',
              linked_post_title: 'A post whose recipe was taken off',
              linked_post_visibility: 'public',
              linked_post_archived_at: null,
              // As a server from before #930's review sent the retired row: a draft.
              linked_post_bundle: { accessMode: 'free', status: 'draft', priceUsdCents: 0 },
            })],
          }))
          : url === POSTS_PAGE_URL
            ? Promise.resolve(jsonResponse({ posts: [postWithRetiredRecipe] }))
            : null
      ));

      render(<CreationsPage />);

      const card = await screen.findByTestId('creation-card-gen-retired');
      await waitFor(() => expect(within(card).getByRole('link', { name: /^add recipe$/i })).toHaveAttribute(
        'href',
        '/post/post-retired/edit?recipe=add&from=creations&returnTo=%2Fcreations#recipe',
      ));
      expect(within(card).queryByRole('link', { name: /^manage recipe$/i })).not.toBeInTheDocument();
    });
  });

  // A free unlock stopped counting as a sale on 2026-10-17 (decision 6): the
  // line counts paid sales, and free unlocks beside them once there are any.
  it("says what each recipe sold and earned, with its free unlocks beside them", async () => {
    navigationState.searchParams = new URLSearchParams('view=posts');
    const recipePost = (id: string, title: string, bundle: Record<string, unknown>) => ({
      id,
      generationId: null,
      visibility: 'public',
      archivedAt: null,
      mediaUrl: `https://example.com/${id}.jpg`,
      mediaKind: 'image',
      title,
      description: '',
      prompt: '',
      body: '',
      category: 'image',
      postFormat: 'media',
      sourceKind: 'external',
      sourceTool: 'Midjourney',
      sourceLabel: 'Midjourney',
      createdAt: '2026-06-01T10:00:00.000Z',
      updatedAt: '2026-06-01T10:00:00.000Z',
      publicPath: `/showcase/${id}`,
      ownerPath: `/post/${id}/edit`,
      resourcePath: `/showcase/${id}#recipe`,
      canShare: true,
      bundle: {
        id: `bundle-${id}`,
        status: 'published',
        resourceKinds: ['prompt'],
        ...bundle,
      },
    });
    stubStudioFetch((url) => {
      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({ generations: [] }));
      }
      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({
          posts: [
            recipePost('post-paid', 'Paid recipe post', {
              accessMode: 'paid', priceUsdCents: 900, salesCount: 2, freeUnlockCount: 0, earningsUsdCents: 1530,
            }),
            recipePost('post-free', 'Free recipe post', {
              accessMode: 'free', priceUsdCents: 0, salesCount: 0, freeUnlockCount: 5, earningsUsdCents: 0,
            }),
          ],
        }));
      }
      return null;
    });

    render(<CreationsPage />);

    expect(await screen.findByText('2 sold · $15.30 earned')).toBeInTheDocument();
    expect(screen.getByText('0 sold · 5 free unlocks · $0.00 earned')).toBeInTheDocument();
  });

  it('keeps Post Library previews intrinsically sized and lazy-loaded', async () => {
    navigationState.searchParams = new URLSearchParams('view=posts');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({ generations: [] }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({
          posts: [
            {
              id: 'post-image',
              generationId: null,
              visibility: 'private',
              archivedAt: null,
              mediaUrl: 'https://example.com/post.jpg',
              mediaKind: 'image',
              title: 'Image post preview',
              description: '',
              prompt: '',
              body: '',
              category: 'image',
              postFormat: 'media',
              sourceKind: 'manual',
              sourceTool: null,
              sourceLabel: 'Manual',
              createdAt: '2026-06-01T10:00:00.000Z',
              updatedAt: '2026-06-01T10:00:00.000Z',
              publicPath: null,
              ownerPath: '/post/post-image/edit',
              resourcePath: null,
              canShare: false,
              bundle: null,
            },
            {
              id: 'post-video',
              generationId: null,
              visibility: 'private',
              archivedAt: null,
              mediaUrl: 'https://example.com/post.mp4',
              mediaKind: 'video',
              title: 'Video post preview',
              description: '',
              prompt: '',
              body: '',
              category: 'video',
              postFormat: 'media',
              sourceKind: 'manual',
              sourceTool: null,
              sourceLabel: 'Manual',
              createdAt: '2026-06-01T10:00:00.000Z',
              updatedAt: '2026-06-01T10:00:00.000Z',
              publicPath: null,
              ownerPath: '/post/post-video/edit',
              resourcePath: null,
              canShare: false,
              bundle: null,
            },
          ],
        }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    render(<CreationsPage />);

    const image = await screen.findByAltText('Image post preview');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('decoding', 'async');
    expect(image).toHaveClass('aspect-[4/5]');
    expect(image).not.toHaveClass('h-full');

    // A video row shows its poster and attaches the source only on hover, so
    // a page of rows never starts a metadata fetch of every full-size file.
    const video = document.querySelector('video');
    expect(video).toHaveAttribute('preload', 'none');
    expect(video).not.toHaveAttribute('src');
    expect(video).not.toHaveAttribute('controls');
    expect(video).toHaveClass('aspect-[4/5]');
    expect(video).not.toHaveClass('h-full');
  });

  it('offers the public or private visibility menu on creation cards with a linked post', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [
            {
              id: 'gen-public',
              output_url: 'https://example.com/public.jpg',
              status: 'succeeded',
              created_at: '2026-06-01T10:00:00.000Z',
              duration: 30,
              cost: 1,
              model: 'nano-banana-2',
              category: 'image',
              linked_post_id: 'post-public',
              linked_post_title: 'Public generated post',
              linked_post_visibility: 'public',
              linked_post_archived_at: null,
            },
            {
              id: 'gen-private',
              output_url: 'https://example.com/private.jpg',
              status: 'succeeded',
              created_at: '2026-06-02T10:00:00.000Z',
              duration: 30,
              cost: 1,
              model: 'nano-banana-2',
              category: 'image',
              linked_post_id: 'post-private',
              linked_post_title: 'Private generated post',
              linked_post_visibility: 'private',
              linked_post_archived_at: null,
            },
          ],
        }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      if (url === '/api/posts/post-private') {
        return Promise.resolve(jsonResponse({
          success: true,
          visibility: JSON.parse(String(init?.body)).visibility,
        }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<><CreationsPage /><FeedbackViewport /></>);

    expect(await screen.findByText('Public generated post')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Visibility of Public generated post: Public' })).toBeInTheDocument();
    const privateTrigger = screen.getByRole('button', { name: 'Visibility of Private generated post: Private' });

    fireEvent.click(privateTrigger);
    const menu = await screen.findByRole('menu', { name: 'Visibility of Private generated post' });
    expect(within(menu).queryByRole('menuitemradio', { name: /unlisted/i })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /public/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-private', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ visibility: 'public' }),
      }));
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Post is public.');
    expect(screen.getByRole('button', { name: 'Visibility of Private generated post: Public' })).toBeInTheDocument();
    // Staying on the Creations tab: a visibility change is not a reason to switch views.
    expect(screen.getByText('Public generated post')).toBeInTheDocument();
  });

  it('uses stable creation media frames and a responsive grid while showing only the primary output', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({
              output_url: 'https://example.com/primary.jpg',
              output_urls: [
                'https://example.com/primary.jpg',
                'https://example.com/secondary.jpg',
              ],
            }),
            makeGeneration({
              id: 'gen-video',
              output_url: 'https://example.com/output.mp4',
              model: 'kling-3.0/video',
              category: 'video',
            }),
          ],
        }));
      }

      if (url.startsWith('/api/posts')) {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    render(<CreationsPage />);

    const grid = await screen.findByTestId('creation-grid');
    expect(grid).toHaveClass('items-stretch');
    expect(grid).toHaveClass('[grid-template-columns:repeat(auto-fill,minmax(min(100%,16rem),1fr))]');

    const imageFrame = screen.getByTestId('creation-media-frame-gen-image');
    const videoFrame = screen.getByTestId('creation-media-frame-gen-video');
    expect(imageFrame).toHaveClass('aspect-[4/5]');
    expect(videoFrame).toHaveClass('aspect-[4/5]');

    const image = screen.getByAltText('Generated image');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('decoding', 'async');
    expect(image).toHaveClass('object-contain');
    expect(screen.queryByAltText('Generated image 2')).not.toBeInTheDocument();
    expect(screen.getByText('2 outputs')).toBeInTheDocument();

    const video = document.querySelector('video');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(video).toHaveClass('object-contain');
  });

  it('offers a filter only for a kind it has, and keeps the filter chips horizontally scrollable', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({ generations: [makeGeneration()] }));
      }

      if (url.startsWith('/api/posts')) {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    render(<CreationsPage />);

    const allFilter = await screen.findByRole('link', { name: 'All (1)' });
    expect(allFilter).toHaveClass('shrink-0', 'whitespace-nowrap');
    expect(allFilter.parentElement).toHaveClass('overflow-x-auto');
    // "Audio (0)" and "Videos (0)" were filters that could only ever show nothing.
    expect(within(allFilter.parentElement!).getAllByRole('link').map((link) => link.textContent)).toEqual([
      'All (1)',
      'Images (1)',
    ]);
  });

  // A filter left by Back or a refresh came back as All (owner's report, 2026-11-15): the
  // media filter is the address's, as the view and the post filters are.
  it('keeps the creations media filter in the address', async () => {
    navigationState.searchParams = new URLSearchParams('media=images');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({ generations: [makeGeneration()] }));
      }

      if (url.startsWith('/api/posts')) {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    try {
      render(<CreationsPage />);

      const images = await screen.findByRole('link', { name: 'Images (1)' });
      expect(images).toHaveAttribute('aria-current', 'true');
      expect(images).toHaveAttribute('href', '/creations?media=images');
      expect(screen.getByRole('link', { name: 'All (1)' })).toHaveAttribute('href', '/creations');
      expect(screen.getByRole('link', { name: 'All (1)' })).not.toHaveAttribute('aria-current');
    } finally {
      navigationState.searchParams = new URLSearchParams();
    }
  });

  // Review of #815: kept in a state of the page, the media filter outlived a visit to another
  // section; in the address it came back as All. Each section's filter now rides along through the
  // others' links, the post filter's too.
  it("keeps each section's filter through the other sections", async () => {
    navigationState.searchParams = new URLSearchParams('view=posts&visibility=public&media=images');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/generations')) return Promise.resolve(jsonResponse({ generations: [makeGeneration()] }));
      if (url.startsWith('/api/posts')) return Promise.resolve(jsonResponse({ posts: [] }));
      if (url === '/api/profile') return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    try {
      render(<CreationsPage />);
      const sections = await screen.findByRole('navigation', { name: 'Studio sections' });

      expect(within(sections).getByRole('link', { name: 'Creations' }))
        .toHaveAttribute('href', '/creations?visibility=public&media=images');
      expect(within(sections).getByRole('link', { name: 'Post Library' }))
        .toHaveAttribute('href', '/creations?view=posts&visibility=public&media=images');
    } finally {
      navigationState.searchParams = new URLSearchParams();
    }
  });

  // A photo is never required to sell. The card said "Your selling identity is
  // ready. Add a short bio" to a creator who had a bio and no photo.
  it.each([
    [
      'a bio and no photo',
      { bio: 'I make short clips.' },
      'Your public identity is ready to publish and sell. Add an avatar so people recognize your work.',
    ],
    [
      'a photo and no bio',
      { avatarUrl: 'https://cdn.example.com/avatar.jpg' },
      'Your public identity is ready to publish and sell. Add a short bio so visitors understand your work.',
    ],
    [
      'neither',
      {},
      'Your public identity is ready to publish and sell. Add an avatar and a short bio so people recognize your work.',
    ],
  ])('asks a creator with a handle, a name and %s for what the profile still lacks', async (_case, details, expected) => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({ generations: [] }));
      }

      if (url.startsWith('/api/posts')) {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1', displayName: 'Creator User', ...details }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    render(<CreationsPage />);

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.getByText('Strengthen creator profile')).toBeInTheDocument();
    expect(screen.queryByText(/selling identity/i)).not.toBeInTheDocument();
  });

  it('does not poll while every generation is idle', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval').mockImplementation(
      () => 1 as unknown as ReturnType<typeof window.setInterval>
    );
    const generationFetch = vi.fn(() => Promise.resolve(jsonResponse({ generations: [makeGeneration()] })));
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return generationFetch();
      }

      if (url.startsWith('/api/posts')) {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    render(<CreationsPage />);
    await act(flushPromises);

    expect(screen.getByTestId('creation-card-gen-image')).toBeInTheDocument();
    expect(generationFetch).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('keeps each card\'s lifecycle actions in its overflow menu on both tabs', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({
              id: 'gen-linked',
              title: 'Linked generated post',
              linked_post_id: 'post-linked',
              linked_post_title: 'Linked generated post',
              linked_post_visibility: 'public',
              linked_post_archived_at: null,
            }),
          ],
        }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({
          posts: [
            {
              id: 'post-linked',
              generationId: 'gen-linked',
              visibility: 'public',
              archivedAt: null,
              mediaUrl: 'https://example.com/post.jpg',
              mediaKind: 'image',
              title: 'Linked generated post',
              description: '',
              prompt: '',
              body: '',
              category: 'image',
              postFormat: 'media',
              sourceKind: 'magicbooklet',
              sourceTool: 'magicbooklet',
              sourceLabel: 'magicbooklet',
              createdAt: '2026-06-01T10:00:00.000Z',
              updatedAt: '2026-06-01T10:00:00.000Z',
              publicPath: '/showcase/post-linked',
              ownerPath: '/post/post-linked/edit',
              resourcePath: null,
              canShare: true,
              bundle: null,
            },
            {
              id: 'post-archived',
              generationId: null,
              visibility: 'public',
              archivedAt: '2026-06-02T10:00:00.000Z',
              mediaUrl: null,
              mediaKind: 'text',
              title: 'Archived note',
              description: '',
              prompt: '',
              body: 'A note.',
              category: 'text',
              postFormat: 'text',
              sourceKind: 'manual',
              sourceTool: null,
              sourceLabel: 'Manual',
              createdAt: '2026-06-01T09:00:00.000Z',
              updatedAt: '2026-06-02T10:00:00.000Z',
              publicPath: null,
              ownerPath: '/post/post-archived/edit',
              resourcePath: null,
              canShare: false,
              bundle: null,
            },
          ],
        }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unmount } = render(<CreationsPage />);

    // A creation card: the visible row is the primary work; the rest waits in the menu.
    const card = await screen.findByTestId('creation-card-gen-linked');
    expect(within(card).getByRole('button', { name: 'Details' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Archive creation' })).not.toBeInTheDocument();
    fireEvent.click(within(card).getByRole('button', { name: 'More actions for Linked generated post' }));
    const creationMenu = await screen.findByRole('menu', { name: 'More actions for Linked generated post' });
    expect(within(creationMenu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Copy post link',
      'Download creation',
      'Recreate',
      'Archive creation',
      'Delete creation',
      'Report AI output',
    ]);
    fireEvent.keyDown(creationMenu, { key: 'Escape' });
    unmount();

    // Post Library: the same menu, with the post's own lifecycle inside it.
    navigationState.searchParams = new URLSearchParams('view=posts&visibility=archived');
    render(<CreationsPage />);
    const archivedRow = await screen.findByRole('heading', { name: 'Archived note' });
    expect(screen.queryByRole('button', { name: /^visibility of archived note/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Archived note' }));
    const archivedMenu = await screen.findByRole('menu', { name: 'More actions for Archived note' });
    expect(within(archivedMenu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Restore post',
      'Delete post',
    ]);
    expect(archivedRow).toBeInTheDocument();
  });

  it('shows canonical template results without unsafe lifecycle actions', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({
          generations: [makeGeneration({
            id: 'gen-template-result',
            title: null,
            prompt: null,
            origin: 'template',
            template: {
              runId: 'run-template-1',
              templateId: 'template-1',
              templateTitle: 'Ghost rider transformation',
            },
          })],
        }));
      }

      if (url.startsWith('/api/posts')) {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    render(<CreationsPage />);

    const card = await screen.findByTestId('creation-card-gen-template-result');
    expect(within(card).getByText('Ghost rider transformation')).toBeInTheDocument();
    expect(within(card).getByText('From template')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Open run' })).toHaveAttribute(
      'href',
      '/template-runs/run-template-1',
    );
    expect(within(card).queryByRole('button', { name: 'Archive creation' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Delete creation' })).not.toBeInTheDocument();
  });

  it('preserves unchanged storage-backed media URLs across processing polls', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const firstUrl = makeSignedStorageUrl(nowSeconds + 3600, 'first');
    const rotatedUrl = makeSignedStorageUrl(nowSeconds + 3660, 'rotated');
    let generationRequestCount = 0;
    let pollCallback: (() => void) | null = null;
    vi.spyOn(window, 'setInterval').mockImplementation((handler: TimerHandler) => {
      if (typeof handler === 'function') {
        pollCallback = () => handler();
      }
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        generationRequestCount += 1;
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({
              output_url: generationRequestCount === 1 ? firstUrl : rotatedUrl,
            }),
            makeGeneration({
              id: 'gen-processing',
              output_url: null,
              status: 'processing',
              category: 'video',
            }),
          ],
        }));
      }

      if (url.startsWith('/api/posts')) {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    render(<CreationsPage />);

    await act(flushPromises);
    const image = screen.getByAltText('Generated image');
    expect(image).toHaveAttribute('src', firstUrl);

    expect(pollCallback).not.toBeNull();
    await act(async () => {
      pollCallback?.();
      await flushPromises();
    });

    expect(generationRequestCount).toBe(2);
    expect(screen.getByAltText('Generated image')).toHaveAttribute('src', firstUrl);
  });

  it('replaces an expired cached signed URL with the freshly signed URL', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiredUrl = makeSignedStorageUrl(nowSeconds - 60, 'expired');
    const freshUrl = makeSignedStorageUrl(nowSeconds + 3600, 'fresh');

    window.sessionStorage.setItem('magicbooklet:creations-cache:v1:user-1', JSON.stringify({
      fetchedAt: Date.now(),
      generations: [makeGeneration({ output_url: expiredUrl })],
      posts: [],
      profile: null,
    }));

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({
          generations: [makeGeneration({ output_url: freshUrl })],
        }));
      }

      if (url.startsWith('/api/posts')) {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    render(<CreationsPage />);

    await waitFor(() => {
      expect(screen.getByAltText('Generated image')).toHaveAttribute('src', freshUrl);
    });
  });

  it('restores an unavailable image preview through an owner-scoped temporary upload', async () => {
    let generationRequestCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url === GENERATIONS_PAGE_URL) {
        generationRequestCount += 1;
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({
              output_url: generationRequestCount === 1
                ? 'https://provider.example.com/missing.jpg'
                : 'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/restored.jpg?token=fresh',
              linked_post_id: 'post-private',
              linked_post_visibility: 'private',
            }),
          ],
        }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      if (url === '/api/generations/gen-image/restore-media') {
        return Promise.resolve(jsonResponse({
          success: true,
          outputUrl: 'generated_images/user-1/restored.jpg',
        }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CreationsPage />);

    const image = await screen.findByAltText('Generated image');
    fireEvent.error(image);

    fireEvent.click(await screen.findByRole('button', { name: /restore preview/i }));
    const restoreInput = screen.getByLabelText('Restore preview media');
    expect(restoreInput).toHaveAttribute('accept', 'image/*');

    const replacement = new File(['replacement'], 'replacement.png', { type: 'image/png' });
    fireEvent.change(restoreInput, {
      target: {
        files: [replacement],
      },
    });

    await waitFor(() => {
      expect(temporaryUploadMock).toHaveBeenCalledWith(replacement);
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/generations/gen-image/restore-media', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer layout-session-token',
          'Content-Type': 'application/json',
        }),
        body: expect.any(String),
      }));
    });

    const restoreCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/generations/gen-image/restore-media') as
      | [RequestInfo | URL, RequestInit?]
      | undefined;
    expect(JSON.parse(String(restoreCall?.[1]?.body))).toMatchObject({
      storagePath: 'uploads/user-1/replacement.png',
      originalName: 'replacement.png',
      contentType: 'image/png',
    });
    await waitFor(() => {
      expect(screen.getByAltText('Generated image')).toHaveAttribute(
        'src',
        'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/restored.jpg?token=fresh'
      );
    });
  });

  it('opens the restore picker with the failed creation media type', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({
              id: 'gen-video',
              output_url: 'https://provider.example.com/missing.mp4',
              model: 'kling-3.0/video',
              category: 'video',
            }),
          ],
        }));
      }

      if (url.startsWith('/api/posts')) {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));

    render(<CreationsPage />);

    const video = await waitFor(() => {
      const element = document.querySelector('video');
      expect(element).not.toBeNull();
      return element as HTMLVideoElement;
    });
    fireEvent.error(video);

    const restoreInput = screen.getByLabelText('Restore preview media') as HTMLInputElement;
    let acceptWhenOpened = '';
    restoreInput.click = vi.fn(() => {
      acceptWhenOpened = restoreInput.accept;
    });

    fireEvent.click(await screen.findByRole('button', { name: /restore preview/i }));

    expect(acceptWhenOpened).toBe('video/*');
  });

  // The first-page refresh after a delete kept every previous row the fresh
  // page lacked whenever fewer came back than were on screen, so the deleted
  // card moved to the end of the grid, was written back into the session
  // snapshot, and a second Delete answered 404 "Creation not found.".
  it('drops a deleted creation from the grid, the session snapshot and the refresh after it', async () => {
    let library = Array.from({ length: 10 }, (_, index) => makeGeneration({
      id: `gen-${index + 1}`,
      title: `Creation ${index + 1}`,
      created_at: new Date(Date.UTC(2026, 5, 20 - index)).toISOString(),
    }));
    const fetchMock = stubStudioFetch((url, init) => {
      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: library,
          pagination: { limit: 36, hasMore: false, nextCursor: null },
        }));
      }
      if (url.startsWith('/api/generations/') && init?.method === 'DELETE') {
        const generationId = url.slice('/api/generations/'.length);
        if (!library.some((generation) => generation.id === generationId)) {
          return Promise.resolve(jsonResponse({ error: 'Creation not found.' }, { status: 404 }));
        }
        library = library.filter((generation) => generation.id !== generationId);
        return Promise.resolve(jsonResponse({ success: true, deleted: true }));
      }
      return null;
    });

    render(<><CreationsPage /><FeedbackViewport /></>);

    await screen.findByTestId('creation-card-gen-4');
    await chooseCardAction('Creation 4', 'Delete creation');
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this creation?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(firstPageReads(fetchMock)).toBe(2);
    });
    await act(flushPromises);

    expect(screen.queryByTestId('creation-card-gen-4')).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/^creation-card-/)).toHaveLength(9);
    const snapshot = JSON.parse(
      window.sessionStorage.getItem('magicbooklet:creations-cache:v1:user-1') ?? '{}',
    ) as { generations?: Array<{ id: string }> };
    expect(snapshot.generations?.map((generation) => generation.id)).toEqual(
      library.map((generation) => generation.id),
    );
    // Nothing is left to delete a second time, so no 404 can come of it.
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    expect(screen.queryByText('Creation not found.')).not.toBeInTheDocument();
  });

  it('takes a deleted creation off the grid and out of the snapshot even when the refresh after it fails', async () => {
    let pageReads = 0;
    stubStudioFetch((url, init) => {
      if (url === GENERATIONS_PAGE_URL) {
        pageReads += 1;
        return pageReads === 1
          ? Promise.resolve(jsonResponse({
            generations: [
              makeGeneration({ id: 'gen-keep', title: 'Keep me' }),
              makeGeneration({ id: 'gen-drop', title: 'Drop me', created_at: '2026-05-31T10:00:00.000Z' }),
            ],
          }))
          : Promise.resolve(jsonResponse({ error: 'Unavailable' }, { status: 503 }));
      }
      if (url === '/api/generations/gen-drop' && init?.method === 'DELETE') {
        return Promise.resolve(jsonResponse({ success: true, deleted: true }));
      }
      return null;
    });

    render(<><CreationsPage /><FeedbackViewport /></>);

    await chooseCardAction('Drop me', 'Delete creation');
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Delete this creation?' }))
      .getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Could not load your creations. Check your connection and try again.')).toBeInTheDocument();
    expect(screen.queryByTestId('creation-card-gen-drop')).not.toBeInTheDocument();
    expect(screen.getByTestId('creation-card-gen-keep')).toBeInTheDocument();
    const snapshot = JSON.parse(
      window.sessionStorage.getItem('magicbooklet:creations-cache:v1:user-1') ?? '{}',
    ) as { generations?: Array<{ id: string }> };
    expect(snapshot.generations?.map((generation) => generation.id)).toEqual(['gen-keep']);
  });

  it('keeps the loaded pages, and Load more goes on after them, when the first page is refreshed', async () => {
    let firstPage = [
      makeGeneration({ id: 'gen-new-1', title: 'Newest creation', created_at: '2026-06-03T10:00:00.000Z' }),
      makeGeneration({ id: 'gen-new-2', title: 'Newer creation', created_at: '2026-06-02T10:00:00.000Z' }),
    ];
    const fetchMock = stubStudioFetch((url, init) => {
      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: firstPage,
          pagination: { limit: 36, hasMore: true, nextCursor: '36' },
        }));
      }
      if (url === NEXT_GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({
          generations: [makeGeneration({ id: 'gen-old-1', title: 'Older creation', created_at: '2026-05-01T10:00:00.000Z' })],
          pagination: { limit: 36, hasMore: true, nextCursor: '72' },
        }));
      }
      if (url === `${GENERATIONS_PAGE_URL}&cursor=72`) {
        return Promise.resolve(jsonResponse({
          generations: [makeGeneration({ id: 'gen-old-2', title: 'Oldest creation', created_at: '2026-04-01T10:00:00.000Z' })],
          pagination: { limit: 36, hasMore: false, nextCursor: null },
        }));
      }
      if (url === '/api/generations/gen-new-2/archive' && init?.method === 'POST') {
        // Meanwhile the newest one was deleted on another device.
        firstPage = [makeGeneration({
          id: 'gen-new-2',
          title: 'Newer creation',
          created_at: '2026-06-02T10:00:00.000Z',
          archived_at: '2026-06-04T10:00:00.000Z',
        })];
        return Promise.resolve(jsonResponse({ success: true }));
      }
      return null;
    });

    render(<><CreationsPage /><FeedbackViewport /></>);

    expect(await screen.findByText('Newest creation')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load more creations/i }));
    expect(await screen.findByText('Older creation')).toBeInTheDocument();

    // Archiving refreshes the first page while the second is on screen.
    await chooseCardAction('Newer creation', 'Archive creation');
    fireEvent.click(within(await screen.findByRole('alertdialog', { name: 'Archive this creation?' }))
      .getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(firstPageReads(fetchMock)).toBe(2);
    });
    await act(flushPromises);

    // Missing from inside the fresh page's range: deleted. Older than it: pushed down, kept.
    expect(screen.queryByText('Newest creation')).not.toBeInTheDocument();
    expect(screen.getByText('Older creation')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /load more creations/i }));
    expect(await screen.findByText('Oldest creation')).toBeInTheDocument();
    // The refresh did not rewind Load more onto the page already on screen.
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === NEXT_GENERATIONS_PAGE_URL)).toHaveLength(1);
  });

  it('says a refunded failure gave its credits back and why it failed, and keeps the cost of one that did not', async () => {
    stubStudioFetch((url) => (url === GENERATIONS_PAGE_URL
      ? Promise.resolve(jsonResponse({
        generations: [
          failedVideoFixture,
          { ...failedVideoFixture, id: 'failed-kept', title: 'Kept its cost', refunded: false, error_message: null },
          { ...failedVideoFixture, id: 'failed-one', title: 'One credit back', cost: 1 },
        ],
      }))
      : null));

    render(<CreationsPage />);

    const refunded = await screen.findByTestId('failed-card-failed-video-1');
    expect(within(refunded).getByText('40 credits returned')).toBeInTheDocument();
    expect(within(refunded).getByText(String(failedVideoFixture.error_message))).toBeInTheDocument();
    expect(within(refunded).queryByText('Credits')).not.toBeInTheDocument();

    const kept = screen.getByTestId('failed-card-failed-kept');
    expect(within(kept).getByText('Credits')).toBeInTheDocument();
    expect(within(kept).getByText('40')).toBeInTheDocument();
    expect(within(kept).queryByText(/returned/)).not.toBeInTheDocument();

    expect(within(screen.getByTestId('failed-card-failed-one')).getByText('1 credit returned')).toBeInTheDocument();
  });

  // Moderation archives what it takes down, and Restore then answers 404
  // "Creation not found." for it.
  it('names a creation moderation took down and offers no Restore for it', async () => {
    stubStudioFetch((url) => (url === GENERATIONS_PAGE_URL
      ? Promise.resolve(jsonResponse({
        generations: [
          makeGeneration({
            id: 'gen-removed',
            title: 'Taken down',
            archived_at: '2026-06-02T10:00:00.000Z',
            moderation_removed_at: '2026-06-02T10:00:00.000Z',
          }),
          makeGeneration({ id: 'gen-archived', title: 'Put away', archived_at: '2026-06-02T10:00:00.000Z' }),
        ],
      }))
      : null));

    render(<CreationsPage />);

    const removed = await screen.findByTestId('archived-card-gen-removed');
    expect(within(removed).getByText('Removed by moderation')).toBeInTheDocument();
    expect(within(removed).queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
    fireEvent.click(within(removed).getByRole('button', { name: 'More actions for Taken down' }));
    const menu = await screen.findByRole('menu', { name: 'More actions for Taken down' });
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Delete creation']);

    const archived = screen.getByTestId('archived-card-gen-archived');
    expect(within(archived).getByText('Archived')).toBeInTheDocument();
    expect(within(archived).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  // A failed run's alert opened `?generation=`, and the modal rendered nothing
  // for a run with no media; the run's card sat below the whole Completed
  // grid, and a first page that arrived after it dropped it.
  it('explains the failed run an alert opened, keeps it through the first page, and rings and scrolls to its card', async () => {
    navigationState.searchParams = new URLSearchParams('generation=failed-video-1');
    const scrollIntoView = vi.fn();
    const ownScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView });
    const requestedRun = { ...failedVideoFixture, title: 'Neon street', input_media: [], paywallPrefill: null };
    let releaseFirstPage: () => void = () => undefined;
    const firstPageReady = new Promise<void>((resolve) => {
      releaseFirstPage = resolve;
    });
    stubStudioFetch((url) => {
      if (url === GENERATIONS_PAGE_URL) {
        // Lands after the run's own read, and does not carry the older run.
        return firstPageReady.then(() => jsonResponse({
          generations: [makeGeneration({ id: 'gen-newer', title: 'Newer creation', created_at: '2026-10-14T09:00:00.000Z' })],
        }));
      }
      if (url === generationDetailUrl('failed-video-1')) {
        return Promise.resolve(jsonResponse({ generations: [requestedRun] }));
      }
      return null;
    });

    try {
      render(<CreationsPage />);

      const dialog = await screen.findByRole('dialog', { name: 'Neon street' });
      expect(within(dialog).getByText('Failed')).toBeInTheDocument();
      expect(within(dialog).getByText(String(failedVideoFixture.error_message))).toBeInTheDocument();
      expect(within(dialog).getByText('40 credits returned')).toBeInTheDocument();
      // What its card offers, never Publish.
      expect(within(dialog).queryByRole('link', { name: 'Publish' })).not.toBeInTheDocument();
      expect(within(dialog).getByRole('link', { name: 'Try again' })).toHaveAttribute('href', '/create-video?remix=failed-video-1');

      await act(async () => {
        releaseFirstPage();
        await flushPromises();
      });
      expect(await screen.findByText('Newer creation')).toBeInTheDocument();

      const card = screen.getByTestId('failed-card-failed-video-1');
      expect(card).toHaveAttribute('data-highlighted', 'true');
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.contexts[0]).toBe(card);
    } finally {
      if (ownScrollIntoView) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', ownScrollIntoView);
      } else {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    }
  });

  // A signed URL lives for an hour, and a tab left open past it turned every
  // tile into "Preview unavailable", whose Restore overwrites the creation.
  it('loads an expired tile once more through the media route before it offers Restore', async () => {
    const expiredUrl = makeSignedStorageUrl(Math.floor(Date.now() / 1000) - 60, 'expired');
    stubStudioFetch((url) => (url === GENERATIONS_PAGE_URL
      ? Promise.resolve(jsonResponse({ generations: [makeGeneration({ output_url: expiredUrl })] }))
      : null));

    render(<CreationsPage />);

    const image = await screen.findByAltText('Generated image');
    expect(image).toHaveAttribute('src', expiredUrl);
    fireEvent.error(image);

    expect(screen.getByAltText('Generated image')).toHaveAttribute(
      'src',
      '/api/media?bucket=generated_images&path=user%2Foutput.jpg',
    );
    expect(screen.queryByRole('button', { name: /restore preview/i })).not.toBeInTheDocument();

    fireEvent.error(screen.getByAltText('Generated image'));
    expect(await screen.findByRole('button', { name: /restore preview/i })).toBeInTheDocument();
  });

  // Storage is another origin, where browsers ignore `download` and only open a tab.
  it('downloads a stored creation through the media route as an attachment, and a remote one from its own address', async () => {
    const storedUrl = makeSignedStorageUrl(Math.floor(Date.now() / 1000) + 3600, 'fresh');
    stubStudioFetch((url) => (url === GENERATIONS_PAGE_URL
      ? Promise.resolve(jsonResponse({
        generations: [
          makeGeneration({ id: 'gen-stored', title: 'Stored creation', output_url: storedUrl }),
          makeGeneration({
            id: 'gen-remote',
            title: 'Remote creation',
            output_url: 'https://cdn.example.com/remote.png',
            created_at: '2026-05-31T10:00:00.000Z',
          }),
        ],
      }))
      : null));

    render(<CreationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'More actions for Stored creation' }));
    const storedMenu = await screen.findByRole('menu', { name: 'More actions for Stored creation' });
    const storedDownload = within(storedMenu).getByRole('menuitem', { name: 'Download creation' });
    expect(storedDownload).toHaveAttribute(
      'href',
      '/api/media?bucket=generated_images&path=user%2Foutput.jpg&download=1&filename=creation_gen-stored.jpg',
    );
    expect(storedDownload).toHaveAttribute('target', '_blank');
    expect(storedDownload).toHaveAttribute('download', 'creation_gen-stored.jpg');
    fireEvent.keyDown(storedMenu, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Remote creation' }));
    const remoteMenu = await screen.findByRole('menu', { name: 'More actions for Remote creation' });
    expect(within(remoteMenu).getByRole('menuitem', { name: 'Download creation' }))
      .toHaveAttribute('href', 'https://cdn.example.com/remote.png');
  });

  it("files a creation's AI output with the safety team the way the app does", async () => {
    const fetchMock = stubStudioFetch((url) => {
      if (url === GENERATIONS_PAGE_URL) {
        return Promise.resolve(jsonResponse({ generations: [makeGeneration({ title: 'Odd output' })] }));
      }
      if (url === '/api/moderation/reports') {
        return Promise.resolve(jsonResponse({ success: true }));
      }
      return null;
    });

    render(<><CreationsPage /><FeedbackViewport /></>);

    await chooseCardAction('Odd output', 'Report AI output');
    const dialog = await screen.findByRole('alertdialog', { name: 'Report offensive AI output?' });
    expect(dialog).toHaveTextContent(
      'Send this generated result to the safety team so the model and provider output can be reviewed.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Report AI output' }));

    expect(await screen.findByText('The generated output was sent to the safety team.')).toBeInTheDocument();
    const reportCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/moderation/reports');
    expect(reportCall?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer layout-session-token' }),
    });
    expect(JSON.parse(String(reportCall?.[1]?.body))).toEqual({
      targetType: 'generation',
      targetId: 'gen-image',
      reason: 'offensive_ai_output',
      sourceSurface: 'generation-viewer',
      details: 'Reported from the web Studio.',
    });
  });

  it('sends a signed-out visitor to sign in with the view and the run they were on', async () => {
    navigationState.searchParams = new URLSearchParams('view=posts&generation=gen-1');
    const signedInSession = authState.session;
    authState.session = null as unknown as typeof authState.session;

    try {
      render(<CreationsPage />);

      await waitFor(() => {
        expect(navigationState.push).toHaveBeenCalledWith(
          `/login?returnUrl=${encodeURIComponent('/creations?view=posts&generation=gen-1')}`,
        );
      });
      expect(navigationState.push).not.toHaveBeenCalledWith('/login');
    } finally {
      authState.session = signedInSession;
    }
  });

  // A cancelled or failed run keeps its finished steps in the library; only a
  // succeeded run's result may publish.
  it('marks the finished steps of an ended template run and offers no Publish for them', async () => {
    const templateOutput = (id: string, runStatus: string, templateTitle: string) => makeGeneration({
      id,
      title: null,
      prompt: null,
      origin: 'template',
      template: { runId: `run-${id}`, templateId: 'template-1', templateTitle, runStatus },
    });
    stubStudioFetch((url) => (url === GENERATIONS_PAGE_URL
      ? Promise.resolve(jsonResponse({
        generations: [
          templateOutput('gen-cancelled-step', 'cancelled', 'Ghost rider'),
          templateOutput('gen-failed-step', 'failed', 'Neon cut'),
          templateOutput('gen-result', 'succeeded', 'Product spin'),
        ],
      }))
      : null));

    render(<CreationsPage />);

    const cancelled = await screen.findByTestId('creation-card-gen-cancelled-step');
    expect(within(cancelled).getByText('From template · run cancelled')).toBeInTheDocument();
    expect(within(cancelled).getByRole('link', { name: 'Open run' })).toHaveAttribute(
      'href',
      '/template-runs/run-gen-cancelled-step',
    );
    expect(within(cancelled).queryByRole('link', { name: 'Publish' })).not.toBeInTheDocument();

    const failed = screen.getByTestId('creation-card-gen-failed-step');
    expect(within(failed).getByText('From template · run failed')).toBeInTheDocument();
    expect(within(failed).queryByRole('link', { name: 'Publish' })).not.toBeInTheDocument();

    const result = screen.getByTestId('creation-card-gen-result');
    expect(within(result).getByText('From template')).toBeInTheDocument();
    expect(within(result).getByRole('link', { name: 'Publish' })).toHaveAttribute(
      'href',
      '/post/new?generationId=gen-result&from=creations&returnTo=%2Fcreations',
    );
    // A template's output is not filed as the creator's own model output.
    fireEvent.click(within(result).getByRole('button', { name: 'More actions for Product spin' }));
    const menu = await screen.findByRole('menu', { name: 'More actions for Product spin' });
    expect(within(menu).queryByRole('menuitem', { name: 'Report AI output' })).not.toBeInTheDocument();
  });

  // Recreate was in the card's overflow menu from the start and in the app
  // everywhere, but the details offered it only for a failed run ("Try again"),
  // so making another of a finished creation meant closing the details first.
  describe("Recreate in a creation's details", () => {
    const openDetails = async (generation: { id: string } & Record<string, unknown>, title: string) => {
      stubStudioFetch((url) => (
        url === GENERATIONS_PAGE_URL || url === generationDetailUrl(generation.id)
          ? Promise.resolve(jsonResponse({ generations: [generation] }))
          : null
      ));
      render(<CreationsPage />);
      fireEvent.click(
        within(await screen.findByTestId(`creation-card-${generation.id}`)).getByRole('button', { name: 'Details' }),
      );
      return screen.findByRole('dialog', { name: title });
    };

    it("reopens the creator on a finished creation, in the card menu's words", async () => {
      const dialog = await openDetails(
        makeGeneration({ id: 'gen-fresh', title: 'Fresh portrait' }),
        'Fresh portrait',
      );

      expect(within(dialog).getByRole('link', { name: 'Recreate' }))
        .toHaveAttribute('href', '/create-image?remix=gen-fresh');
      // "Try again" is the failed run's wording and stays its own.
      expect(within(dialog).queryByRole('link', { name: 'Try again' })).not.toBeInTheDocument();
    });

    // canRecreate: neither has a creator to reopen on its settings.
    it('offers none for a template result', async () => {
      const dialog = await openDetails(
        makeGeneration({
          id: 'gen-from-template',
          title: 'Product spin',
          origin: 'template',
          template: { runId: 'run-1', templateId: 'tpl-1', templateTitle: 'Product spin', runStatus: 'succeeded' },
        }),
        'Product spin',
      );

      expect(within(dialog).queryByRole('link', { name: 'Recreate' })).not.toBeInTheDocument();
      expect(within(dialog).getByRole('link', { name: 'Open template run' })).toBeInTheDocument();
    });

    it('offers none for an audio creation', async () => {
      const dialog = await openDetails(
        makeGeneration({
          id: 'gen-voice',
          title: 'Voice over',
          category: 'audio',
          model: 'text-to-speech-turbo-2-5',
          output_url: 'https://example.com/output.mp3',
        }),
        'Voice over',
      );

      expect(within(dialog).queryByRole('link', { name: 'Recreate' })).not.toBeInTheDocument();
    });

    // A failed card carries no Details button, so its alert's address opens it.
    it('keeps "Try again" on a failed run', async () => {
      const burnt = makeGeneration({
        id: 'gen-burnt',
        title: 'Burnt run',
        status: 'failed',
        output_url: null,
        category: 'video',
        model: 'veo-3-1',
        error_message: 'The provider gave up.',
      });
      navigationState.searchParams = new URLSearchParams('generation=gen-burnt');
      stubStudioFetch((url) => (
        url === GENERATIONS_PAGE_URL || url === generationDetailUrl('gen-burnt')
          ? Promise.resolve(jsonResponse({ generations: [burnt] }))
          : null
      ));
      render(<CreationsPage />);

      const dialog = await screen.findByRole('dialog', { name: 'Burnt run' });
      expect(within(dialog).getByRole('link', { name: 'Try again' }))
        .toHaveAttribute('href', '/create-video?remix=gen-burnt');
      expect(within(dialog).queryByRole('link', { name: 'Recreate' })).not.toBeInTheDocument();
    });
  });

  // Studio drew no view count anywhere, while the post page, the reel, Home's
  // cards, the profile tiles and the creator header all did. The rule is the
  // shared one (ugc-mobile/lib/view-count/): nothing at 0, nothing for a post
  // that is not public, so an unposted or private creation shows none at all.
  describe('view counts across Studio', () => {
    const publishedCreation = (overrides: Record<string, unknown> = {}) => makeGeneration({
      id: 'gen-seen',
      title: 'Seen portrait',
      linked_post_id: 'post-seen',
      linked_post_title: 'Seen portrait',
      linked_post_visibility: 'public',
      linked_post_archived_at: null,
      linked_post_view_count: 1234,
      ...overrides,
    });

    const stubCreation = (generation: { id: string } & Record<string, unknown>) => stubStudioFetch((url) => (
      url === GENERATIONS_PAGE_URL || url === generationDetailUrl(generation.id)
        ? Promise.resolve(jsonResponse({ generations: [generation] }))
        : null
    ));

    it("draws a public post's count on the creation card and in its details", async () => {
      stubCreation(publishedCreation());
      render(<CreationsPage />);

      const card = await screen.findByTestId('creation-card-gen-seen');
      // The compact figure beside the eye, and the whole number for a screen reader.
      expect(within(card).getByText('1.2K')).toBeInTheDocument();
      expect(within(card).getByText('1,234 views')).toBeInTheDocument();
      expect(within(card).getByText('Views')).toBeInTheDocument();

      fireEvent.click(within(card).getByRole('button', { name: 'Details' }));
      const dialog = await screen.findByRole('dialog', { name: 'Seen portrait' });
      expect(within(dialog).getByText('1.2K')).toBeInTheDocument();
      expect(within(dialog).getByText('1,234 views')).toBeInTheDocument();
    });

    it('draws none for a creation whose post is private', async () => {
      stubCreation(publishedCreation({ linked_post_visibility: 'private' }));
      render(<CreationsPage />);

      const card = await screen.findByTestId('creation-card-gen-seen');
      expect(within(card).queryByText('Views')).not.toBeInTheDocument();
      expect(within(card).queryByText('1,234 views')).not.toBeInTheDocument();

      fireEvent.click(within(card).getByRole('button', { name: 'Details' }));
      const dialog = await screen.findByRole('dialog', { name: 'Seen portrait' });
      expect(within(dialog).queryByText('1,234 views')).not.toBeInTheDocument();
    });

    it('draws none for a creation with no post', async () => {
      stubCreation(makeGeneration({ id: 'gen-quiet', title: 'Quiet portrait' }));
      render(<CreationsPage />);

      const card = await screen.findByTestId('creation-card-gen-quiet');
      expect(within(card).getByText('Not published')).toBeInTheDocument();
      expect(within(card).queryByText('Views')).not.toBeInTheDocument();

      fireEvent.click(within(card).getByRole('button', { name: 'Details' }));
      const dialog = await screen.findByRole('dialog', { name: 'Quiet portrait' });
      expect(within(dialog).queryByText(/views$/)).not.toBeInTheDocument();
    });

    it("draws a Post Library card's own count, and none for a private post", async () => {
      navigationState.searchParams = new URLSearchParams('view=posts');
      stubStudioFetch((url) => {
        if (url.startsWith('/api/generations')) {
          return Promise.resolve(jsonResponse({ generations: [] }));
        }
        if (url === '/api/posts?scope=owner&includeArchived=true&limit=36&offset=0') {
          return Promise.resolve(jsonResponse({
            posts: [
              { ...makePost('seen', 'public'), title: 'Seen note', viewCount: 1234 },
              { ...makePost('hidden', 'private'), title: 'Hidden note', viewCount: 99 },
            ],
          }));
        }
        return null;
      });
      render(<CreationsPage />);

      const seen = await screen.findByTestId('post-card-seen');
      expect(within(seen).getByText('1.2K')).toBeInTheDocument();
      expect(within(seen).getByText('1,234 views')).toBeInTheDocument();

      const hidden = screen.getByTestId('post-card-hidden');
      expect(within(hidden).queryByText('Views')).not.toBeInTheDocument();
      expect(within(hidden).queryByText('99 views')).not.toBeInTheDocument();
    });
  });
});
