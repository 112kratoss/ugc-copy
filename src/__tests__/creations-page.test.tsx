import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import CreationsPage from '@/app/creations/page';
import FeedbackViewport from '@/components/FeedbackViewport';
import { resetFeedbackState } from '@/components/feedback-state';

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
    const unlocks = within(sections).getByRole('link', { name: 'Unlocks' });

    expect(creations).toHaveAttribute('href', '/creations');
    expect(posts).toHaveAttribute('href', '/creations?view=posts');
    expect(unlocks).toHaveAttribute('href', '/creations?view=unlocks');
    // Unlocks was not representable in the URL before.
    expect(unlocks).toHaveAttribute('aria-current', 'page');
    expect(creations).not.toHaveAttribute('aria-current');
    expect(posts).not.toHaveAttribute('aria-current');
    expect(screen.queryByRole('button', { name: 'Post Library' })).not.toBeInTheDocument();
    expect(screen.getByText('YOUR UNLOCKS')).toBeInTheDocument();
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
    // One control with the three states; it reads the current one.
    const trigger = screen.getByRole('button', { name: 'Visibility of Public portrait post: Public' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu', { name: 'Visibility of Public portrait post' });
    expect(within(menu).getByRole('menuitemradio', { name: /public/i })).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByRole('menuitemradio', { name: /unlisted/i })).toBeInTheDocument();
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

  // The quick publish modal rebuilds a recipe from the generation prefill and
  // sends no body, so opening it on a post that already exists would replace
  // whatever the editor saved. An existing post's recipe is always edited in
  // the editor, which loads the stored bundle.
  it('links a generated card Add recipe action to the post editor instead of the publish modal', async () => {
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

    const addRecipeLink = await screen.findByRole('link', { name: /^add recipe$/i });
    expect(addRecipeLink).toHaveAttribute(
      'href',
      '/post/post-linked/edit?resourceMode=paid&focus=price&from=creations#recipe',
    );
    expect(screen.queryByRole('button', { name: /^add recipe$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /publish this creation/i })).not.toBeInTheDocument();
    // No detail fetch: the link needs nothing beyond the linked post id.
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/generations?includeArchived=true&id=gen-linked&limit=1',
      expect.anything(),
    );
  });

  it('links a Post Library Manage recipe action to the post editor for a generation-backed post', async () => {
    navigationState.searchParams = new URLSearchParams('view=posts');
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
    // the saved access mode rather than the modal's Paid / 900 default.
    const manageRecipeLink = await screen.findByRole('link', { name: /^manage recipe$/i });
    expect(manageRecipeLink).toHaveAttribute(
      'href',
      '/post/post-bundled/edit?resourceMode=free&focus=price&from=creations#recipe',
    );
    expect(screen.queryByRole('button', { name: /^manage recipe$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /publish this creation/i })).not.toBeInTheDocument();

    // An uploaded post with no recipe gets the same entry point.
    expect(screen.getByRole('link', { name: /^add recipe$/i })).toHaveAttribute(
      'href',
      '/post/post-uploaded/edit?resourceMode=paid&focus=price&from=creations#recipe',
    );
    expect(navigationState.push).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith('/api/showcase/publish', expect.anything());
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

  it('offers the three-state visibility menu on creation cards with a linked post', async () => {
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
    // Unlisted was unreachable from the old two-way toggle.
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /unlisted/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-private', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ visibility: 'unlisted' }),
      }));
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Post is unlisted.');
    expect(screen.getByRole('button', { name: 'Visibility of Private generated post: Unlisted' })).toBeInTheDocument();
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

  it('shows filtered empty states and keeps filter chips horizontally scrollable', async () => {
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

    const audioFilter = await screen.findByRole('button', { name: /audio \(0\)/i });
    expect(audioFilter).toHaveClass('shrink-0', 'whitespace-nowrap');
    expect(audioFilter.parentElement).toHaveClass('overflow-x-auto');

    fireEvent.click(audioFilter);

    expect(await screen.findByText('No audio creations yet')).toBeInTheDocument();
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
      expect(within(dialog).queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
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
    expect(within(cancelled).queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();

    const failed = screen.getByTestId('creation-card-gen-failed-step');
    expect(within(failed).getByText('From template · run failed')).toBeInTheDocument();
    expect(within(failed).queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();

    const result = screen.getByTestId('creation-card-gen-result');
    expect(within(result).getByText('From template')).toBeInTheDocument();
    expect(within(result).getByRole('button', { name: 'Publish' })).toBeInTheDocument();
    // A template's output is not filed as the creator's own model output.
    fireEvent.click(within(result).getByRole('button', { name: 'More actions for Product spin' }));
    const menu = await screen.findByRole('menu', { name: 'More actions for Product spin' });
    expect(within(menu).queryByRole('menuitem', { name: 'Report AI output' })).not.toBeInTheDocument();
  });
});
