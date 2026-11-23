import { useRef, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  POST_VIEW_FLUSH_DELAY_MS,
  POST_VIEW_MAX_WAIT_MS,
  flushPostViews,
  isPostHalfOnScreen,
  reportPostView,
  resetPostViewReporterForTests,
  usePostViewOnScreen,
} from '@/app/showcase/post-view-reporter';
import { QualifiedImpressionBoundary, resetShowcaseFeedEventQueueForTests } from '@/app/showcase/ShowcaseFeedInteraction';
import type { ShowcaseFeedItem } from '@/lib/showcase';

const POST_A = '11111111-1111-4111-8111-111111111111';
const POST_B = '22222222-2222-4222-8222-222222222222';

/** A bearer token whose payload names `sub`, as Supabase's do (the signature is never read here). */
function tokenFor(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url');
  return `header.${payload}.signature`;
}

type SentRequest = { url: string; init: RequestInit; body: { views: Array<{ postId: string; surface: string }> } };

function viewRequests(): SentRequest[] {
  return vi.mocked(fetch).mock.calls
    .filter(([url]) => String(url) === '/api/showcase/views')
    .map(([url, init]) => ({ url: String(url), init: init as RequestInit, body: JSON.parse(String((init as RequestInit).body)) }));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let fetchStatus = 204;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-23T12:00:00.000Z'));
  fetchStatus = 204;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: fetchStatus })));
  resetPostViewReporterForTests();
  resetShowcaseFeedEventQueueForTests();
});

afterEach(() => {
  resetPostViewReporterForTests();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('reportPostView', () => {
  it('sends a batch as JSON, with keepalive, once the queue has been quiet for a while', async () => {
    reportPostView({ postId: POST_A, surface: 'feed' });
    reportPostView({ postId: POST_B, surface: 'post-page' });
    vi.advanceTimersByTime(POST_VIEW_FLUSH_DELAY_MS - 1);
    expect(viewRequests()).toHaveLength(0);

    vi.advanceTimersByTime(1);
    await settle();
    const [request] = viewRequests();
    expect(viewRequests()).toHaveLength(1);
    expect(request.init).toEqual(expect.objectContaining({ method: 'POST', keepalive: true }));
    expect(request.init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(request.body).toEqual({
      views: [
        { postId: POST_A, surface: 'feed' },
        { postId: POST_B, surface: 'post-page' },
      ],
    });
  });

  it('sends a signed-in reader’s views with their bearer token, and a guest’s apart from them', async () => {
    const token = tokenFor('reader-1');
    reportPostView({ postId: POST_A, surface: 'feed', accessToken: token });
    reportPostView({ postId: POST_B, surface: 'feed' });
    await act(async () => { await flushPostViews(); });

    const requests = viewRequests();
    expect(requests).toHaveLength(2);
    expect(requests[0].init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
    expect(requests[0].body.views).toEqual([{ postId: POST_A, surface: 'feed' }]);
    expect(requests[1].init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(requests[1].body.views).toEqual([{ postId: POST_B, surface: 'feed' }]);
  });

  it('sends a full batch of 25 at once, and the 26th with the next', async () => {
    const ids = Array.from({ length: 26 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    ids.slice(0, 25).forEach((postId) => reportPostView({ postId, surface: 'feed' }));
    await settle();
    expect(viewRequests()).toHaveLength(1);
    expect(viewRequests()[0].body.views).toHaveLength(25);

    reportPostView({ postId: ids[25], surface: 'feed' });
    vi.advanceTimersByTime(POST_VIEW_FLUSH_DELAY_MS);
    await settle();
    expect(viewRequests()).toHaveLength(2);
    expect(viewRequests()[1].body.views).toEqual([{ postId: ids[25], surface: 'feed' }]);
  });

  it('holds a steady stream of views no longer than the longest wait', async () => {
    for (let index = 0; index < 8; index += 1) {
      reportPostView({ postId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, surface: 'feed' });
      vi.advanceTimersByTime(POST_VIEW_FLUSH_DELAY_MS - 1_000);
    }
    // 8 views, 4 s apart: the quiet never came, and the first has waited 32 s.
    await settle();
    expect(viewRequests()).toHaveLength(1);
    expect(viewRequests()[0].body.views.length).toBeGreaterThanOrEqual(7);
    expect(POST_VIEW_MAX_WAIT_MS).toBe(30_000);
  });

  it('reports a post once a reader and UTC day, whatever surface saw it again', async () => {
    reportPostView({ postId: POST_A, surface: 'feed' });
    reportPostView({ postId: POST_A, surface: 'post-page' });
    reportPostView({ postId: POST_A, surface: 'reel' });
    await act(async () => { await flushPostViews(); });
    expect(viewRequests()).toHaveLength(1);
    expect(viewRequests()[0].body.views).toEqual([{ postId: POST_A, surface: 'feed' }]);

    // Another reader on the same page is another view.
    reportPostView({ postId: POST_A, surface: 'reel', accessToken: tokenFor('reader-2') });
    await act(async () => { await flushPostViews(); });
    expect(viewRequests()).toHaveLength(2);

    // So is the next UTC day.
    vi.setSystemTime(new Date('2026-11-24T00:00:01.000Z'));
    reportPostView({ postId: POST_A, surface: 'feed' });
    await act(async () => { await flushPostViews(); });
    expect(viewRequests()).toHaveLength(3);
  });

  it('lets views go after a send that was not answered for good, so a later look reports again', async () => {
    fetchStatus = 503;
    reportPostView({ postId: POST_A, surface: 'feed' });
    await act(async () => { await flushPostViews(); });
    expect(viewRequests()).toHaveLength(1);

    fetchStatus = 204;
    reportPostView({ postId: POST_A, surface: 'feed' });
    await act(async () => { await flushPostViews(); });
    expect(viewRequests()).toHaveLength(2);

    // Answered: not again.
    reportPostView({ postId: POST_A, surface: 'feed' });
    await act(async () => { await flushPostViews(); });
    expect(viewRequests()).toHaveLength(2);
  });

  it('keeps a view a refusal answered for good, and lets a lost request’s go', async () => {
    fetchStatus = 400;
    reportPostView({ postId: POST_A, surface: 'feed' });
    await act(async () => { await flushPostViews(); });
    reportPostView({ postId: POST_A, surface: 'feed' });
    await act(async () => { await flushPostViews(); });
    expect(viewRequests()).toHaveLength(1);

    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    reportPostView({ postId: POST_B, surface: 'feed' });
    await act(async () => { await flushPostViews(); });
    reportPostView({ postId: POST_B, surface: 'feed' });
    await act(async () => { await flushPostViews(); });
    expect(viewRequests().filter((request) => request.body.views[0].postId === POST_B)).toHaveLength(2);
  });

  it('sends what waits as the page is left, and as it is hidden', async () => {
    reportPostView({ postId: POST_A, surface: 'post-page' });
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(viewRequests()).toHaveLength(1);
    expect(viewRequests()[0].init.keepalive).toBe(true);

    reportPostView({ postId: POST_B, surface: 'post-page' });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockRestore();
    await settle();
    expect(viewRequests()).toHaveLength(2);
    expect(viewRequests()[1].body.views).toEqual([{ postId: POST_B, surface: 'post-page' }]);
  });
});

describe('isPostHalfOnScreen', () => {
  const rect = (height: number) => ({ height }) as DOMRectReadOnly;

  it('asks half of the post, as the feed’s qualified impression does', () => {
    expect(isPostHalfOnScreen({ isIntersecting: true, intersectionRatio: 0.5, intersectionRect: rect(200), rootBounds: rect(800) })).toBe(true);
    expect(isPostHalfOnScreen({ isIntersecting: true, intersectionRatio: 0.49, intersectionRect: rect(196), rootBounds: rect(800) })).toBe(false);
    expect(isPostHalfOnScreen({ isIntersecting: false, intersectionRatio: 0, intersectionRect: rect(0), rootBounds: rect(800) })).toBe(false);
  });

  it('takes half the screen for a post too tall to show half of itself', () => {
    // A 3,000px post on an 800px screen shows at most 27% of itself.
    expect(isPostHalfOnScreen({ isIntersecting: true, intersectionRatio: 0.14, intersectionRect: rect(420), rootBounds: rect(800) })).toBe(true);
    expect(isPostHalfOnScreen({ isIntersecting: true, intersectionRatio: 0.12, intersectionRect: rect(360), rootBounds: rect(800) })).toBe(false);
  });
});

describe('usePostViewOnScreen', () => {
  let observerCallback: IntersectionObserverCallback | null = null;
  let observedElement: Element | null = null;

  beforeEach(() => {
    observerCallback = null;
    observedElement = null;
    vi.stubGlobal('IntersectionObserver', vi.fn(function IntersectionObserverMock(callback: IntersectionObserverCallback) {
      observerCallback = callback;
      return {
        root: null,
        rootMargin: '0px',
        thresholds: [],
        observe: vi.fn((element: Element) => { observedElement = element; }),
        unobserve: vi.fn(),
        disconnect: vi.fn(() => { observerCallback = null; }),
        takeRecords: vi.fn(() => []),
      } satisfies IntersectionObserver;
    }));
  });

  function show(ratio: number) {
    act(() => {
      observerCallback?.([{
        isIntersecting: ratio > 0,
        intersectionRatio: ratio,
        intersectionRect: { height: ratio * 400 } as DOMRectReadOnly,
        rootBounds: { height: 800 } as DOMRectReadOnly,
        target: observedElement,
      } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
  }

  function PostPage({ postId = POST_A, enabled = true, accessToken = null }: { postId?: string; enabled?: boolean; accessToken?: string | null }) {
    const ref = useRef<HTMLElement | null>(null);
    usePostViewOnScreen(ref, { postId, surface: 'post-page', accessToken, enabled });
    return <section ref={ref}>Post</section>;
  }

  async function sentViews() {
    await act(async () => { await flushPostViews(); });
    return viewRequests().flatMap((request) => request.body.views);
  }

  it('reports the post after a second half on screen, and not a moment before', async () => {
    render(<PostPage />);
    show(1);
    act(() => { vi.advanceTimersByTime(999); });
    expect(await sentViews()).toEqual([]);

    act(() => { vi.advanceTimersByTime(1); });
    expect(await sentViews()).toEqual([{ postId: POST_A, surface: 'post-page' }]);
  });

  it('reports nothing for a post scrolled away within the second, or shown under half', async () => {
    render(<PostPage />);
    show(0.4);
    act(() => { vi.advanceTimersByTime(2_000); });
    show(1);
    act(() => { vi.advanceTimersByTime(600); });
    show(0);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(await sentViews()).toEqual([]);
  });

  it('counts no second while the page is in the background', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    render(<PostPage />);
    show(1);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(await sentViews()).toEqual([]);

    visibility.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    act(() => { vi.advanceTimersByTime(1_000); });
    visibility.mockRestore();
    expect(await sentViews()).toEqual([{ postId: POST_A, surface: 'post-page' }]);
  });

  it('holds a view that qualified until it may be sent, and sends it once', async () => {
    function Gate() {
      const [enabled, setEnabled] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setEnabled(true)}>Session known</button>
          <PostPage enabled={enabled} accessToken={enabled ? tokenFor('reader-1') : null} />
        </>
      );
    }
    render(<Gate />);
    show(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(await sentViews()).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Session known' }));
    const requests = viewRequests();
    await act(async () => { await flushPostViews(); });
    expect(viewRequests().slice(requests.length)).toHaveLength(1);
    expect(viewRequests().at(-1)?.init.headers).toEqual(expect.objectContaining({ Authorization: `Bearer ${tokenFor('reader-1')}` }));

    show(0);
    show(1);
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(await sentViews()).toHaveLength(1);
  });

  it('never reports a view that may not be sent', async () => {
    render(<PostPage enabled={false} />);
    show(1);
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(await sentViews()).toEqual([]);
  });

  it('reports the next post the page comes to show', async () => {
    const { rerender } = render(<PostPage />);
    show(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    rerender(<PostPage postId={POST_B} />);
    show(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(await sentViews()).toEqual([
      { postId: POST_A, surface: 'post-page' },
      { postId: POST_B, surface: 'post-page' },
    ]);
  });
});

describe('QualifiedImpressionBoundary views', () => {
  let observerCallback: IntersectionObserverCallback | null = null;
  let observedElement: Element | null = null;

  beforeEach(() => {
    observerCallback = null;
    observedElement = null;
    vi.stubGlobal('IntersectionObserver', vi.fn(function IntersectionObserverMock(callback: IntersectionObserverCallback) {
      observerCallback = callback;
      return {
        root: null,
        rootMargin: '0px',
        thresholds: [0.5],
        observe: vi.fn((element: Element) => { observedElement = element; }),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
        takeRecords: vi.fn(() => []),
      } satisfies IntersectionObserver;
    }));
  });

  const item = {
    id: POST_A,
    mediaUrl: null,
    mediaKind: 'image',
    model: 'nano-banana-2',
    title: 'Campaign Frame',
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-11-20T10:00:00.000Z',
    creator: { id: 'creator-1', username: 'creator', name: 'Creator', avatar: null },
    sourceKind: 'magicbooklet',
    sourceTool: null,
  } as ShowcaseFeedItem;

  function renderCard(props: { viewSurface?: 'feed'; viewReady?: boolean; children?: ReactNode } = {}) {
    return render(
      <QualifiedImpressionBoundary item={item} position={0} sourceSurface="feed" viewSurface={props.viewSurface} viewReady={props.viewReady}>
        {props.children ?? 'Card'}
      </QualifiedImpressionBoundary>,
    );
  }

  function showCard(ratio: number) {
    act(() => {
      observerCallback?.([{ isIntersecting: ratio > 0, intersectionRatio: ratio, target: observedElement } as IntersectionObserverEntry], {} as IntersectionObserver);
    });
  }

  it('reports a Home card’s view after a second half on screen, an unranked card’s too', async () => {
    renderCard({ viewSurface: 'feed' });
    showCard(0.6);
    act(() => { vi.advanceTimersByTime(999); });
    await act(async () => { await flushPostViews(); });
    expect(viewRequests()).toHaveLength(0);

    act(() => { vi.advanceTimersByTime(1); });
    await act(async () => { await flushPostViews(); });
    expect(viewRequests().flatMap((request) => request.body.views)).toEqual([{ postId: POST_A, surface: 'feed' }]);
  });

  it('reports nothing where the boundary names no view surface (Explore’s grid)', async () => {
    renderCard();
    showCard(1);
    act(() => { vi.advanceTimersByTime(2_000); });
    await act(async () => { await flushPostViews(); });
    expect(viewRequests()).toHaveLength(0);
  });

  it('holds the view until the session is known', async () => {
    const { rerender } = renderCard({ viewSurface: 'feed', viewReady: false });
    showCard(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    await act(async () => { await flushPostViews(); });
    expect(viewRequests()).toHaveLength(0);

    rerender(
      <QualifiedImpressionBoundary item={item} position={0} sourceSurface="feed" viewSurface="feed" viewReady>
        Card
      </QualifiedImpressionBoundary>,
    );
    await act(async () => { await flushPostViews(); });
    expect(viewRequests().flatMap((request) => request.body.views)).toEqual([{ postId: POST_A, surface: 'feed' }]);
  });
});
