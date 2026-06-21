import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreationsPage from '@/app/creations/page';

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
    storage: {
      from: () => ({
        upload: temporaryUploadMock,
      }),
    },
  },
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
    temporaryUploadMock.mockResolvedValue({ error: null });

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({ generations: [] }));
      }

      if (url.startsWith('/api/posts')) {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('uses the authenticated layout session for tab data instead of importing a fresh Supabase session', async () => {
    render(<CreationsPage />);

    expect(await screen.findByRole('heading', { name: /studio/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(GENERATIONS_PAGE_URL, {
        headers: { Authorization: 'Bearer layout-session-token' },
      });
    });

    expect(fetch).toHaveBeenCalledWith('/api/posts?scope=owner&includeArchived=true', {
      headers: { Authorization: 'Bearer layout-session-token' },
    });
    expect(fetch).toHaveBeenCalledWith('/api/profile', {
      headers: { Authorization: 'Bearer layout-session-token' },
    });
    expect(getSessionMock).not.toHaveBeenCalled();
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

      if (url === '/api/posts?scope=owner&includeArchived=true') {
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

      if (url === '/api/posts?scope=owner&includeArchived=true') {
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

    render(<CreationsPage />);

    expect(await screen.findByText('Public portrait post')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /make private/i }));

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
  });

  it('opens the publish setup modal from a generated card Add unlock action', async () => {
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

      if (url === '/api/generations?includeArchived=true&id=gen-linked&limit=1') {
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({
              id: 'gen-linked',
              title: 'Linked generated post',
              linked_post_id: 'post-linked',
              linked_post_title: 'Linked generated post',
              linked_post_visibility: 'public',
              linked_post_archived_at: null,
              paywallPrefill: {
                resourceKinds: ['prompt', 'notes', 'remix'],
                promptText: 'Create a generated portrait.',
                notesMarkdown: 'Saved generation setup',
                allowRemix: true,
              },
            }),
          ],
        }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true') {
        return Promise.resolve(jsonResponse({ posts: [] }));
      }

      if (url === '/api/profile') {
        return Promise.resolve(jsonResponse({ username: 'creator-user1' }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CreationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^add unlock$/i }));

    expect(await screen.findByRole('dialog', { name: /publish this creation/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/generations?includeArchived=true&id=gen-linked&limit=1', {
      headers: { Authorization: 'Bearer layout-session-token' },
    });
    expect(screen.getByRole('checkbox', { name: /sell the prompt and setup/i })).toBeChecked();
    expect(navigationState.push).not.toHaveBeenCalled();
  });

  it('removes an existing unlock from a generation-backed Post Library Manage unlock action', async () => {
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

      if (url === '/api/generations?includeArchived=true&id=gen-bundled&limit=1') {
        return Promise.resolve(jsonResponse({
          generations: [
            makeGeneration({
              id: 'gen-bundled',
              title: 'Bundled generated post',
              paywallPrefill: {
                resourceKinds: ['prompt', 'notes', 'remix'],
                promptText: 'Create a reusable generated portrait.',
                notesMarkdown: 'Saved bundled setup',
                allowRemix: true,
              },
            }),
          ],
        }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true') {
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
              resourcePath: '/showcase/post-bundled#resources',
              canShare: true,
              bundle: {
                id: 'bundle-1',
                accessMode: 'paid',
                status: 'draft',
                priceUsdCents: 900,
                salesCount: 0,
                earningsUsdCents: 0,
                resourceKinds: ['prompt', 'notes', 'remix'],
              },
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
          visibility: 'public',
          postId: 'post-bundled',
          resourceBundleStatus: null,
          resourceBundlePath: null,
        }));
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CreationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: /^manage unlock$/i }));

    expect(await screen.findByRole('dialog', { name: /publish this creation/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/generations?includeArchived=true&id=gen-bundled&limit=1', {
      headers: { Authorization: 'Bearer layout-session-token' },
    });
    const sellPackageCheckbox = screen.getByRole('checkbox', { name: /sell the prompt and setup/i });
    expect(sellPackageCheckbox).toBeChecked();
    expect(navigationState.push).not.toHaveBeenCalled();

    fireEvent.click(sellPackageCheckbox);
    expect(sellPackageCheckbox).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /^public post$/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/showcase/publish', expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }));
    });

    const publishCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/showcase/publish') as
      | [RequestInfo | URL, RequestInit?]
      | undefined;
    expect(JSON.parse(String(publishCall?.[1]?.body))).toMatchObject({
      generationId: 'gen-bundled',
      visibility: 'public',
      resourceBundle: {
        accessMode: 'none',
      },
    });
  });

  it('keeps Post Library previews intrinsically sized and lazy-loaded', async () => {
    navigationState.searchParams = new URLSearchParams('view=posts');
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith('/api/generations')) {
        return Promise.resolve(jsonResponse({ generations: [] }));
      }

      if (url === '/api/posts?scope=owner&includeArchived=true') {
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

    const video = document.querySelector('video');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(video).toHaveClass('aspect-[4/5]');
    expect(video).not.toHaveClass('h-full');
  });

  it('shows one-click public and private visibility actions on creation cards', async () => {
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

      if (url === '/api/posts?scope=owner&includeArchived=true') {
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

    render(<CreationsPage />);

    expect(await screen.findByText('Public generated post')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /make private/i })).toHaveClass('w-full', 'rounded-2xl');
    expect(screen.getByRole('button', { name: /make public/i })).toHaveClass('w-full', 'rounded-2xl');

    fireEvent.click(screen.getByRole('button', { name: /make public/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/showcase/publish', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          generationId: 'gen-private',
          visibility: 'public',
        }),
      }));
    });
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

  it('preserves unchanged storage-backed media URLs across processing polls', async () => {
    const firstUrl = 'https://project.supabase.co/storage/v1/object/sign/generated_images/user/output.jpg?token=first';
    const rotatedUrl = 'https://project.supabase.co/storage/v1/object/sign/generated_images/user/output.jpg?token=rotated';
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

      if (url === '/api/posts?scope=owner&includeArchived=true') {
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
        expect.stringMatching(/^user-1\/.+\.png$/),
        replacement,
        expect.objectContaining({
          contentType: 'image/png',
          upsert: false,
        })
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
      storagePath: expect.stringMatching(/^uploads\/user-1\/.+\.png$/),
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
