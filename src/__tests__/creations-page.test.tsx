import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreationsPage from '@/app/creations/page';
import FeedbackViewport from '@/app/components/FeedbackViewport';
import { resetFeedbackState } from '@/app/components/feedback-state';

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

vi.mock('@/app/components/AuthProvider', () => ({
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

      if (url === '/api/showcase/publish') {
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

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/showcase/publish', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer layout-session-token',
        }),
        body: expect.any(String),
      }));
    });

    const publishCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/showcase/publish') as
      | [RequestInfo | URL, RequestInit?]
      | undefined;
    expect(JSON.parse(String(publishCall?.[1]?.body))).toEqual({
      generationId: 'gen-public',
      visibility: 'private',
    });
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

      if (url === '/api/showcase/publish') {
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
      expect(fetchMock).toHaveBeenCalledWith('/api/showcase/publish', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          generationId: 'gen-private',
          visibility: 'unlisted',
        }),
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
      expect(temporaryUploadMock).toHaveBeenCalledWith(
        replacement,
        'user-1'
      );
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
});
