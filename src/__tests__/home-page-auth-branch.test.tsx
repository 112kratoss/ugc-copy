import { PassThrough } from 'node:stream';

import type { ReactElement } from 'react';
import { renderToPipeableStream } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getServerAuthStateMock = vi.fn();
const loadHomeFeedMock = vi.fn();
const loadHomeWorkspaceGenerationsMock = vi.fn();
const loadHomeWhatsNewModelsMock = vi.fn();
const feedClientPropsMock = vi.fn();

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => getServerAuthStateMock(),
}));

vi.mock('@/lib/home-dashboard-service', () => ({
  loadHomeFeed: (args: unknown) => loadHomeFeedMock(args),
  loadHomeWorkspaceGenerations: (args: unknown) => loadHomeWorkspaceGenerationsMock(args),
  loadHomeWhatsNewModels: () => loadHomeWhatsNewModelsMock(),
}));

vi.mock('@/app/components/AnonymousHome', () => ({
  default: () => <div data-testid="anonymous-home" />,
}));

vi.mock('@/app/home/StaleSessionRecovery', () => ({
  default: () => <div data-testid="stale-session-recovery" />,
}));

vi.mock('@/app/home/WorkspaceCard', () => ({
  default: () => <div data-testid="workspace-card" />,
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

  it('shows the create rail to signed-in creators too, greeted by name', async () => {
    getServerAuthStateMock.mockResolvedValue({
      session: { user: { id: 'user-1', email: 'sassy@example.test', user_metadata: { full_name: 'Sassy Manjeri' } } },
      credits: 88,
    });
    const { default: HomeDashboardPage } = await import('@/app/home/page');

    const html = await renderPageToHtml(
      await HomeDashboardPage({ searchParams: Promise.resolve({}) }),
    );

    // The rail shipped signed-out only at first, so signing in swapped it for
    // the workspace strip — mobile shows it either way, and so should this.
    expect(html).toContain('home-slider-track');
    expect(html).toContain('Ready when you are, Sassy Manjeri');
  });

  it('greets from the email when the account carries no name', async () => {
    getServerAuthStateMock.mockResolvedValue({
      session: { user: { id: 'user-1', email: 'sassy@example.test' } },
      credits: 88,
    });
    const { default: HomeDashboardPage } = await import('@/app/home/page');

    const html = await renderPageToHtml(
      await HomeDashboardPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain('Ready when you are, sassy');
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
