import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CreationsPage from '@/app/creations/page';

const navigationState = vi.hoisted(() => ({
  push: vi.fn(),
  searchParams: new URLSearchParams(),
}));

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  usePathname: () => '/creations',
  useRouter: () => ({
    push: navigationState.push,
  }),
  useSearchParams: () => navigationState.searchParams,
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: {
      access_token: 'layout-session-token',
      user: { id: 'user-1' },
    },
  }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
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

describe('CreationsPage', () => {
  beforeEach(() => {
    navigationState.push.mockClear();
    navigationState.searchParams = new URLSearchParams();
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({ data: { session: null } });

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
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the authenticated layout session for tab data instead of importing a fresh Supabase session', async () => {
    render(<CreationsPage />);

    expect(await screen.findByRole('heading', { name: /my creations/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/generations?includeArchived=true', {
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
    expect(fetch).toHaveBeenCalledWith('/api/generations?includeArchived=true', {
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

    const publishCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/showcase/publish');
    expect(JSON.parse(String(publishCall?.[1]?.body))).toEqual({
      generationId: 'gen-public',
      visibility: 'private',
    });
  });

  it('shows one-click public and private visibility actions on creation cards', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === '/api/generations?includeArchived=true') {
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
});
