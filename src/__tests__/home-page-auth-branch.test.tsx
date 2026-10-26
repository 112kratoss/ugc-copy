import { PassThrough } from 'node:stream';

import type { ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServerAuthStateMock = vi.fn();
const loadHomeFeedMock = vi.fn();
const loadHomeWorkspaceGenerationsMock = vi.fn();
const loadHomeWhatsNewModelsMock = vi.fn();
const feedClientPropsMock = vi.fn();
const loadHomeShelfMock = vi.fn();

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => getServerAuthStateMock(),
}));

vi.mock('@/lib/home-dashboard-service', () => ({
  loadHomeFeed: (args: unknown) => loadHomeFeedMock(args),
  loadHomeWorkspaceGenerations: (args: unknown) => loadHomeWorkspaceGenerationsMock(args),
  loadHomeWhatsNewModels: () => loadHomeWhatsNewModelsMock(),
}));

vi.mock('@/lib/home-shelf-server', () => ({
  homeShelfHasEnoughPins: () => true,
  loadHomeShelf: (identity: unknown) => loadHomeShelfMock(identity),
}));

vi.mock('@/components/AnonymousHome', () => ({
  default: () => <div data-testid="anonymous-home" />,
}));

vi.mock('@/app/home/StaleSessionRecovery', () => ({
  default: () => <div data-testid="stale-session-recovery" />,
}));

vi.mock('@/app/home/WorkspaceCard', () => ({
  default: () => <div data-testid="workspace-card" />,
}));

// Reads the browser Supabase client, which needs env this test does not set.
vi.mock('@/app/home/WelcomeCreditsCard', () => ({
  default: () => null,
}));

vi.mock('@/app/feed/FeedClient', () => ({
  default: (props: Record<string, unknown>) => {
    feedClientPropsMock(props);
    return <div data-testid="feed-client" />;
  },
}));

function renderPageToHtml(element: ReactElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    sink.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sink.on('error', reject);

    const { pipe } = renderToPipeableStream(element, {
      onAllReady() {
        pipe(sink);
      },
      onError(error) {
        reject(error);
      },
    });
  });
}

const EMPTY_FEED = {
  items: [],
  availableTools: [],
  pageInfo: { hasMore: false, nextOffset: null, limit: 12, offset: 0 },
};

const SHELF = ['boat', 'serum', 'dance'].map((id) => ({
  kind: 'creation' as const,
  id,
  title: `Creation ${id}`,
  tool: 'image' as const,
  posterUrl: `https://cdn.example.test/${id}/poster.webp`,
  posterThumbhash: null,
  clipUrl: null,
  modelName: 'Nano Banana 2',
  price: { kind: 'credits' as const, credits: 8 },
  fitsWelcomeCredits: true,
  badge: null,
  creator: { id: 'creator-1', username: 'magicbooklet', name: 'Magicbooklet Team' },
  makeHref: `/create-image?remix=generation-${id}&remixPost=${id}`,
}));

describe('HomeDashboardPage auth branch', () => {
  beforeEach(() => {
    vi.resetModules();
    getServerAuthStateMock.mockReset();
    loadHomeFeedMock.mockReset();
    loadHomeWorkspaceGenerationsMock.mockReset();
    loadHomeWhatsNewModelsMock.mockReset();
    feedClientPropsMock.mockReset();
    loadHomeFeedMock.mockResolvedValue(EMPTY_FEED);
    loadHomeWorkspaceGenerationsMock.mockResolvedValue([]);
    loadHomeWhatsNewModelsMock.mockResolvedValue([]);
    loadHomeShelfMock.mockReset();
    loadHomeShelfMock.mockResolvedValue(SHELF);
  });

  it('falls back to the signed-out home with recovery when the session is stale', async () => {
    getServerAuthStateMock.mockResolvedValue({ session: null, credits: null });
    const { default: HomeDashboardPage } = await import('@/app/home/page');

    const html = await renderPageToHtml(
      await HomeDashboardPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain('anonymous-home');
    expect(html).toContain('stale-session-recovery');
    expect(loadHomeFeedMock).not.toHaveBeenCalled();
    expect(loadHomeWorkspaceGenerationsMock).not.toHaveBeenCalled();
    expect(loadHomeWhatsNewModelsMock).not.toHaveBeenCalled();
  });

  it('renders the dashboard for a verified session', async () => {
    getServerAuthStateMock.mockResolvedValue({
      session: { user: { id: 'user-1' } },
      credits: 88,
    });
    const { default: HomeDashboardPage } = await import('@/app/home/page');

    const html = await renderPageToHtml(
      await HomeDashboardPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain('feed-client');
    expect(html).toContain('workspace-card');
    expect(html).not.toContain('anonymous-home');
    expect(loadHomeFeedMock).toHaveBeenCalledWith(expect.objectContaining({
      viewerUserId: 'user-1',
      chip: expect.objectContaining({ id: 'for-you' }),
    }));
    expect(loadHomeWorkspaceGenerationsMock).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(feedClientPropsMock).toHaveBeenCalledWith(expect.objectContaining({
      variant: 'embedded',
      detailContext: { from: 'home', returnTo: '/' },
      initialChipId: 'for-you',
    }));
  });

  it('shows the shelf to signed-in members with their own offers, and never "Free to try"', async () => {
    getServerAuthStateMock.mockResolvedValue({
      session: { user: { id: 'user-1', is_anonymous: false } },
      credits: 88,
    });
    loadHomeShelfMock.mockResolvedValue([
      SHELF[0],
      SHELF[1],
      { kind: 'action', id: 'post' },
      SHELF[2],
      { kind: 'action', id: 'invite', inviterPercent: 5, inviteePercent: 5 },
    ]);
    const { default: HomeDashboardPage } = await import('@/app/home/page');

    const html = await renderPageToHtml(
      await HomeDashboardPage({ searchParams: Promise.resolve({}) }),
    );

    expect(loadHomeShelfMock).toHaveBeenCalledWith({ viewerUserId: 'user-1', isAnonymous: false });
    expect(html).toContain('home-shelf-track');
    expect(html).toContain('Share your first post');
    expect(html).toContain('You get 5% of their top-ups in credits.');
    // A member already holds the welcome credits the badge promises.
    expect(html).not.toContain('Free to try');
  });

  it('asks the shelf about a guest session as a guest', async () => {
    getServerAuthStateMock.mockResolvedValue({
      session: { user: { id: 'guest-1', is_anonymous: true } },
      credits: 0,
    });
    const { default: HomeDashboardPage } = await import('@/app/home/page');

    await renderPageToHtml(
      await HomeDashboardPage({ searchParams: Promise.resolve({}) }),
    );

    expect(loadHomeShelfMock).toHaveBeenCalledWith({ viewerUserId: 'guest-1', isAnonymous: true });
  });

  it('maps the chip query onto the feed lane', async () => {
    getServerAuthStateMock.mockResolvedValue({
      session: { user: { id: 'user-1' } },
      credits: 88,
    });
    const { default: HomeDashboardPage } = await import('@/app/home/page');

    await renderPageToHtml(
      await HomeDashboardPage({ searchParams: Promise.resolve({ chip: 'recent' }) }),
    );

    expect(loadHomeFeedMock).toHaveBeenCalledWith(expect.objectContaining({
      chip: expect.objectContaining({ id: 'recent', sort: 'recent' }),
    }));
    expect(feedClientPropsMock).toHaveBeenCalledWith(expect.objectContaining({
      initialChipId: 'recent',
    }));
  });
});
