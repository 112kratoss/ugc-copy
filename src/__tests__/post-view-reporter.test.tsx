import { Profiler, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  POST_VIEW_FLUSH_DELAY_MS,
  POST_VIEW_MAX_WAIT_MS,
  SCREEN_MIDDLE_ROOT_MARGIN,
  flushPostViews,
  newestEntryFor,
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

  // A page the back/forward cache keeps hears that answer when it is brought back.
  it('lets the views of the batch sent as the page was left go too, when that send fails', async () => {
    fetchStatus = 503;
    reportPostView({ postId: POST_A, surface: 'post-page' });
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(viewRequests()).toHaveLength(1);

    fetchStatus = 204;
    reportPostView({ postId: POST_A, surface: 'post-page' });
    await act(async () => { await flushPostViews(); });
    expect(viewRequests()).toHaveLength(2);
  });
});

describe('newestEntryFor', () => {
  it('takes the last of a callback’s entries for the element, as they come oldest first', () => {
    const post = document.createElement('section');
    const other = document.createElement('section');
    const entries = [
      { target: post, isIntersecting: true },
      { target: other, isIntersecting: true },
      { target: post, isIntersecting: false },
    ];
    expect(newestEntryFor(entries, post)).toBe(entries[2]);
    expect(newestEntryFor(entries, other)).toBe(entries[1]);
    expect(newestEntryFor(entries, document.createElement('div'))).toBeUndefined();
  });
});

type FakeObserver = { callback: IntersectionObserverCallback; options: IntersectionObserverInit | undefined; targets: Element[] };

function stubIntersectionObservers(): FakeObserver[] {
  const observers: FakeObserver[] = [];
  vi.stubGlobal('IntersectionObserver', vi.fn(function IntersectionObserverMock(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    const observer: FakeObserver = { callback, options, targets: [] };
    observers.push(observer);
    return {
      root: null,
      rootMargin: options?.rootMargin ?? '0px',
      thresholds: [],
      observe: vi.fn((element: Element) => { observer.targets.push(element); }),
      unobserve: vi.fn(),
      disconnect: vi.fn(() => { observer.targets = []; }),
      takeRecords: vi.fn(() => []),
    } satisfies IntersectionObserver;
  }));
  return observers;
}

function entryOf(target: Element, intersectionRatio: number, isIntersecting = intersectionRatio > 0) {
  return { target, isIntersecting, intersectionRatio } as IntersectionObserverEntry;
}

function setPageHidden(hidden: boolean) {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible');
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  return visibility;
}

describe('usePostViewOnScreen', () => {
  let observers: FakeObserver[] = [];

  beforeEach(() => {
    observers = stubIntersectionObservers();
  });

  /** The live observer of the post: of half of it on screen, or of it across the screen's middle. */
  function watching(kind: 'half' | 'middle') {
    const post = screen.getByTestId('post');
    const observer = observers.findLast((candidate) => candidate.targets.includes(post)
      && (candidate.options?.rootMargin === SCREEN_MIDDLE_ROOT_MARGIN) === (kind === 'middle'));
    expect(observer, `the post's ${kind} is watched`).toBeDefined();
    return { observer: observer!, post };
  }

  /** The share of the post on screen, as its observer is told. */
  function show(ratio: number) {
    const { observer, post } = watching('half');
    act(() => { observer.callback([entryOf(post, ratio)], {} as IntersectionObserver); });
  }

  /** Whether the post crosses the middle of the screen, as its observer is told. */
  function acrossMiddle(across: boolean) {
    const { observer, post } = watching('middle');
    act(() => { observer.callback([entryOf(post, across ? 1 : 0, across)], {} as IntersectionObserver); });
  }

  function PostPage({ postId = POST_A, enabled = true, accessToken = null, drawn = true }: {
    postId?: string;
    enabled?: boolean;
    accessToken?: string | null;
    drawn?: boolean;
  }) {
    const ref = usePostViewOnScreen({ postId, surface: 'post-page', accessToken, enabled });
    return drawn ? <section data-testid="post" ref={ref}>Post</section> : <p>Not available</p>;
  }

  async function sentViews() {
    await act(async () => { await flushPostViews(); });
    return viewRequests().flatMap((request) => request.body.views);
  }

  it('watches half of the post, and the post across the middle of the screen', () => {
    render(<PostPage />);
    expect(watching('half').observer.options?.threshold).toEqual([0, 0.5]);
    expect(watching('middle').observer.options).toEqual(expect.objectContaining({ rootMargin: '-50% 0px -49% 0px' }));
  });

  // The hook's page is the post page's whole body: state set as its post mounts would draw all of it twice.
  it('watches the post without drawing the page around it a second time', () => {
    const commits = vi.fn();
    render(<Profiler id="post-page" onRender={commits}><PostPage /></Profiler>);
    watching('half');
    watching('middle');
    expect(commits).toHaveBeenCalledTimes(1);
  });

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

  // A 20-screen recipe shows 5% of itself at most: the share alone would never be told again.
  it('counts a post taller than the screen once it crosses the screen’s middle, however small a share of it shows', async () => {
    render(<PostPage />);
    show(0.04);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(await sentViews()).toEqual([]);

    acrossMiddle(true);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(await sentViews()).toEqual([{ postId: POST_A, surface: 'post-page' }]);
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

  it('sends a view again on the next look when its send failed', async () => {
    fetchStatus = 503;
    render(<PostPage />);
    show(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(await sentViews()).toHaveLength(1);

    // Still the same look: nothing new.
    fetchStatus = 204;
    show(0.9);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(await sentViews()).toHaveLength(1);

    show(0);
    show(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(await sentViews()).toHaveLength(2);
  });

  it('reports the next day’s view on a look after midnight, from a page left open', async () => {
    vi.setSystemTime(new Date('2026-11-23T23:59:00.000Z'));
    render(<PostPage />);
    show(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(await sentViews()).toHaveLength(1);

    vi.setSystemTime(new Date('2026-11-24T08:00:00.000Z'));
    const visibility = setPageHidden(true);
    visibility.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    act(() => { vi.advanceTimersByTime(1_000); });
    visibility.mockRestore();
    expect(await sentViews()).toEqual([
      { postId: POST_A, surface: 'post-page' },
      { postId: POST_A, surface: 'post-page' },
    ]);
  });

  it('acts on the newest of a callback’s entries', async () => {
    render(<PostPage />);
    const { observer, post } = watching('half');
    act(() => { observer.callback([entryOf(post, 1), entryOf(post, 0)], {} as IntersectionObserver); });
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(await sentViews()).toEqual([]);

    act(() => { observer.callback([entryOf(post, 0), entryOf(post, 1)], {} as IntersectionObserver); });
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(await sentViews()).toEqual([{ postId: POST_A, surface: 'post-page' }]);
  });

  // The post page draws a notice in the post's place for a blocked reader, and the post again once unblocked.
  it('watches the post drawn afresh under the same post', async () => {
    const { rerender } = render(<PostPage />);
    rerender(<PostPage drawn={false} />);
    rerender(<PostPage drawn />);
    show(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(await sentViews()).toEqual([{ postId: POST_A, surface: 'post-page' }]);
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
  let observers: FakeObserver[] = [];

  beforeEach(() => {
    observers = stubIntersectionObservers();
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

  function cardObserver() {
    const observer = observers.findLast((candidate) => candidate.targets.length > 0);
    expect(observer, 'the card is watched').toBeDefined();
    return { observer: observer!, card: observer!.targets[0] };
  }

  function showCard(ratio: number) {
    const { observer, card } = cardObserver();
    act(() => { observer.callback([entryOf(card, ratio)], {} as IntersectionObserver); });
  }

  async function sentViews() {
    await act(async () => { await flushPostViews(); });
    return viewRequests().flatMap((request) => request.body.views);
  }

  it('reports a Home card’s view after a second half on screen, an unranked card’s too', async () => {
    renderCard({ viewSurface: 'feed' });
    showCard(0.6);
    act(() => { vi.advanceTimersByTime(999); });
    expect(await sentViews()).toEqual([]);

    act(() => { vi.advanceTimersByTime(1); });
    expect(await sentViews()).toEqual([{ postId: POST_A, surface: 'feed' }]);
  });

  it('reports nothing where the boundary names no view surface (Explore’s grid)', async () => {
    renderCard();
    showCard(1);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(await sentViews()).toEqual([]);
  });

  it('holds the view until the session is known', async () => {
    const { rerender } = renderCard({ viewSurface: 'feed', viewReady: false });
    showCard(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(await sentViews()).toEqual([]);

    rerender(
      <QualifiedImpressionBoundary item={item} position={0} sourceSurface="feed" viewSurface="feed" viewReady>
        Card
      </QualifiedImpressionBoundary>,
    );
    expect(await sentViews()).toEqual([{ postId: POST_A, surface: 'feed' }]);
  });

  it('counts no second while the page is hidden, and a whole one once it is back', async () => {
    renderCard({ viewSurface: 'feed' });
    showCard(1);
    act(() => { vi.advanceTimersByTime(500); });
    const visibility = setPageHidden(true);
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(await sentViews()).toEqual([]);

    visibility.mockReturnValue('visible');
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    act(() => { vi.advanceTimersByTime(999); });
    expect(await sentViews()).toEqual([]);
    act(() => { vi.advanceTimersByTime(1); });
    visibility.mockRestore();
    expect(await sentViews()).toEqual([{ postId: POST_A, surface: 'feed' }]);
  });

  it('sends a view again on the card’s next look when its send failed', async () => {
    fetchStatus = 503;
    renderCard({ viewSurface: 'feed' });
    showCard(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(await sentViews()).toHaveLength(1);

    fetchStatus = 204;
    showCard(0.2);
    showCard(0.8);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(await sentViews()).toHaveLength(2);

    // Answered: a third look sends nothing more today.
    showCard(0);
    showCard(1);
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(await sentViews()).toHaveLength(2);
  });

  it('acts on the newest of a callback’s entries', async () => {
    renderCard({ viewSurface: 'feed' });
    const { observer, card } = cardObserver();
    act(() => { observer.callback([entryOf(card, 1), entryOf(card, 0)], {} as IntersectionObserver); });
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(await sentViews()).toEqual([]);
  });
});
