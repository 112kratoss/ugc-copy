import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
});
