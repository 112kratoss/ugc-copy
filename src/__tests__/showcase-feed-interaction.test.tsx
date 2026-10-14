import { readFileSync } from 'node:fs';
import path from 'node:path';

import { useEffect, type ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createFeedCardAttention,
  FEED_DWELL_MAX_MS,
  FeedRemovalUndoRow,
  flushShowcaseFeedEvents,
  putBackRemovedFeedItems,
  QualifiedImpressionBoundary,
  resetShowcaseFeedEventQueueForTests,
  sendShowcaseFeedEvent,
  sendShowcaseResourceOpenEvent,
  ShowcaseFeedbackMenu,
  undoShowcaseFeedFeedback,
  undoShowcaseFeedFeedbackAfterHide,
  useFeedCardTelemetry,
  type FeedCardTelemetry,
} from '@/app/showcase/ShowcaseFeedInteraction';
import { sourceVideoProgress } from '@/app/showcase/ShowcaseMediaCarousel';
import type { ShowcaseFeedItem } from '@/lib/showcase';

function createShowcaseItem(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: 'https://example.com/image.jpg',
    mediaKind: 'image',
    model: 'nano-banana-2',
    title: 'Campaign Frame',
    prompt: 'A creator-style product shot by a bright window.',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 4,
    remixCount: 2,
    commentCount: 0,
    createdAt: '2026-03-28T10:00:00.000Z',
    creator: {
      id: 'creator-1',
      username: 'creator-name',
      name: 'Creator Name',
      avatar: null,
    },
    isSaved: false,
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: 'gen-1',
    asset: null,
    canRemix: false,
    recommendation: {
      deliveryId: 'delivery-1',
      position: 7,
      reason: 'Because you save product photography',
      algorithmVersion: 'feed-v1',
    },
    ...overrides,
  };
}

describe('showcase feed interactions', () => {
  let observerCallback: IntersectionObserverCallback | null = null;
  let observedElement: Element | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    observerCallback = null;
    observedElement = null;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }))));
    vi.stubGlobal('IntersectionObserver', vi.fn(function IntersectionObserverMock(
      callback: IntersectionObserverCallback
    ) {
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

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderBoundary(children: ReactNode = 'Preview') {
    return render(
      <QualifiedImpressionBoundary
        item={createShowcaseItem()}
        feedSessionId="session-1"
        accessToken="token-1"
        position={0}
      >
        {children}
      </QualifiedImpressionBoundary>
    );
  }

  it('records one qualified impression after at least half the card is visible for one second', async () => {
    renderBoundary();
    expect(observerCallback).not.toBeNull();
    expect(observedElement).not.toBeNull();

    act(() => {
      observerCallback?.([
        {
          isIntersecting: true,
          intersectionRatio: 0.5,
          target: observedElement,
        } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
      vi.advanceTimersByTime(999);
    });
    expect(fetch).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });

    // Qualification happened, but events are queued and flushed together now.
    expect(fetch).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, request] = vi.mocked(fetch).mock.calls[0];
    expect(request).toEqual(expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
    }));
    expect(JSON.parse(String(request?.body))).toEqual({
      events: [expect.objectContaining({
        feedSessionId: 'session-1',
        deliveryId: 'delivery-1',
        postId: 'post-1',
        eventType: 'impression',
        position: 7,
        sourceSurface: 'showcase',
        metadata: expect.objectContaining({ algorithmVersion: 'feed-v1' }),
      })],
    });

    act(() => {
      observerCallback?.([
        {
          isIntersecting: true,
          intersectionRatio: 1,
          target: observedElement,
        } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
      vi.advanceTimersByTime(1500);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not submit an impression for the temporary unranked SSR fallback', async () => {
    render(
      <QualifiedImpressionBoundary
        item={createShowcaseItem({ recommendation: undefined })}
        feedSessionId={null}
        position={0}
      >
        Preview
      </QualifiedImpressionBoundary>
    );

    await act(async () => {
      observerCallback?.([{
        isIntersecting: true,
        intersectionRatio: 1,
        target: observedElement,
      } as IntersectionObserverEntry], {} as IntersectionObserver);
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels qualification when the card leaves view before one second', () => {
    renderBoundary();

    act(() => {
      observerCallback?.([
        {
          isIntersecting: true,
          intersectionRatio: 0.75,
          target: observedElement,
        } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
      vi.advanceTimersByTime(700);
      observerCallback?.([
        {
          isIntersecting: false,
          intersectionRatio: 0,
          target: observedElement,
        } as IntersectionObserverEntry,
      ], {} as IntersectionObserver);
      vi.advanceTimersByTime(500);
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('offers keyboard-reachable not-interested and hide-creator actions', () => {
    const onSelect = vi.fn();
    render(
      <ShowcaseFeedbackMenu
        itemTitle="Campaign Frame"
        creator={{ username: 'creator-name', name: 'Creator Name' }}
        onSelect={onSelect}
      />
    );

    const trigger = screen.getByRole('button', { name: /more actions for campaign frame/i });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    act(() => vi.advanceTimersByTime(20));

    expect(screen.getByRole('menu', { name: /feedback actions/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /not interested/i })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('menuitem', { name: /not interested/i }), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /hide @creator-name/i })).toHaveFocus();

    fireEvent.click(screen.getByRole('menuitem', { name: /hide @creator-name/i }));
    expect(onSelect).toHaveBeenCalledWith('hide_creator');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('omits hide-creator when the post has no safe creator target', () => {
    render(
      <ShowcaseFeedbackMenu
        itemTitle="Campaign Frame"
        creator={{ username: 'creator-name', name: 'Creator Name' }}
        canHideCreator={false}
        onSelect={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));

    expect(screen.getByRole('menuitem', { name: /not interested/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /hide @creator-name/i })).not.toBeInTheDocument();
  });

  it('offers the five rows the app card menu has, in its order, with safety set apart', () => {
    const onReportContent = vi.fn();
    const onReportUser = vi.fn();
    const onBlockUser = vi.fn();
    render(
      <ShowcaseFeedbackMenu
        variant="inline"
        itemTitle="Campaign Frame"
        creator={{ username: 'fluffy', name: 'Fluffy' }}
        onSelect={vi.fn()}
        onReportContent={onReportContent}
        onReportUser={onReportUser}
        onBlockUser={onBlockUser}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));

    const rows = screen.getAllByRole('menuitem').map((row) => row.querySelector('.font-semibold')?.textContent);
    // The Hide row names the creator by handle, as the card above it and the app's row do.
    expect(rows).toEqual(['Not interested', 'Hide @fluffy', 'Report content', 'Report user', 'Block user']);
    expect(screen.getAllByRole('separator')).toHaveLength(1);

    fireEvent.click(screen.getByRole('menuitem', { name: /block user/i }));
    expect(onBlockUser).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /report user/i }));
    expect(onReportUser).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /report content/i }));
    expect(onReportContent).toHaveBeenCalledTimes(1);
  });

  it('stays open while something else on the page scrolls, and follows its button when the page does', () => {
    // The Home slider scrolls its own track every few seconds; that used to
    // close the menu under the reader.
    const slider = document.createElement('div');
    document.body.appendChild(slider);
    render(
      <ShowcaseFeedbackMenu
        variant="inline"
        itemTitle="Campaign Frame"
        creator={{ username: 'fluffy', name: 'Fluffy' }}
        onSelect={vi.fn()}
        onBlockUser={vi.fn()}
      />
    );
    const trigger = screen.getByRole('button', { name: /more actions for campaign frame/i });
    const rect = (top: number) => ({ top, bottom: top + 36, left: 600, right: 636, width: 36, height: 36, x: 600, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(200));

    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toHaveStyle({ top: '244px' });

    fireEvent.scroll(slider);
    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    // The page scrolls 120px: the menu moves with its button.
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(80));
    fireEvent.scroll(document);
    act(() => vi.advanceTimersByTime(50));
    expect(screen.getByRole('menu')).toHaveStyle({ top: '124px' });

    // Scrolled off the top of the screen: now it closes.
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(-300));
    fireEvent.scroll(document);
    act(() => vi.advanceTimersByTime(50));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    slider.remove();
  });

  // Measured in a browser on 2026-10-10: five rows are 361px (three descriptions
  // wrap), the estimate said 316px, and a menu whose button stood 332px above
  // the foot of the screen opened below it and ran 37px off the bottom.
  it('opens above its button when its real height does not fit below, whatever the estimate said', () => {
    vi.stubGlobal('innerHeight', 900);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function offsetHeight(this: HTMLElement) {
      return this.getAttribute('role') === 'menu' ? 361 : 0;
    });
    render(
      <ShowcaseFeedbackMenu
        portal
        itemTitle="Campaign Frame"
        creator={{ username: 'fluffy', name: 'Fluffy' }}
        onSelect={vi.fn()}
        onReportContent={vi.fn()}
        onReportUser={vi.fn()}
        onBlockUser={vi.fn()}
      />
    );
    const trigger = screen.getByRole('button', { name: /more actions for campaign frame/i });
    const rect = (top: number) => ({ top, bottom: top + 48, left: 423, right: 471, width: 48, height: 48, x: 423, y: top, toJSON: () => ({}) }) as DOMRect;

    // 332px below the button: more than the estimate, less than the menu.
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(520));
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toHaveStyle({ bottom: '388px' });
    expect(screen.getByRole('menu').style.top).toBe('');
    fireEvent.click(trigger);

    // With room for all of it the menu still opens below.
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(400));
    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toHaveStyle({ top: '456px' });

    height.mockRestore();
    vi.unstubAllGlobals();
  });

  // The menu's right edge sits under its button's. A button near the left edge
  // of a narrow screen would push the 256px menu off the left of it.
  it('keeps all of the menu on screen when its button is near the left edge', () => {
    vi.stubGlobal('innerWidth', 390);
    render(
      <ShowcaseFeedbackMenu
        portal
        itemTitle="Campaign Frame"
        creator={{ username: 'fluffy', name: 'Fluffy' }}
        onSelect={vi.fn()}
      />
    );
    const trigger = screen.getByRole('button', { name: /more actions for campaign frame/i });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(
      { top: 200, bottom: 248, left: 137, right: 185, width: 48, height: 48, x: 137, y: 200, toJSON: () => ({}) } as DOMRect,
    );

    fireEvent.click(trigger);
    // 390 - 256 - 8: its left edge is 8px in from the screen's.
    expect(screen.getByRole('menu')).toHaveStyle({ right: '126px' });

    vi.unstubAllGlobals();
  });

  // A handle has no space to wrap at. Measured in a browser on 2026-10-09: 24 wide
  // letters ran 80px past the 256px menu until the label could break anywhere.
  it('lets a long handle break inside its row', () => {
    render(
      <ShowcaseFeedbackMenu
        variant="inline"
        itemTitle="Campaign Frame"
        creator={{ username: 'wwwwwwwwwwwwwwwwwwwwwwww', name: 'W' }}
        onSelect={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));

    const label = screen.getByText('Hide @wwwwwwwwwwwwwwwwwwwwwwww');
    expect(label.className).toContain('[overflow-wrap:anywhere]');
    expect(label.parentElement?.className).toContain('min-w-0');
  });

  // Explore's tile clips what it holds, and five rows are taller than most
  // tiles; the reel is a layer above the body's menus and has the room.
  it("draws a tile's menu in the page body when asked, and leaves the reel's where it is", () => {
    const { unmount } = render(
      <ShowcaseFeedbackMenu
        portal
        itemTitle="Campaign Frame"
        creator={{ username: 'fluffy', name: 'Fluffy' }}
        onSelect={vi.fn()}
        onReportContent={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));
    expect(screen.getByRole('menu').parentElement).toBe(document.body);
    expect(screen.getByRole('menu').className).toContain('fixed');
    unmount();

    render(
      <ShowcaseFeedbackMenu
        itemTitle="Campaign Frame"
        creator={{ username: 'fluffy', name: 'Fluffy' }}
        onSelect={vi.fn()}
        onReportContent={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));
    expect(screen.getByRole('menu').parentElement).not.toBe(document.body);
    expect(screen.getByRole('menu').className).toContain('absolute');
  });

  // The pointer leaves the tile to reach a menu drawn in the body, and the
  // tile shows its controls on hover: without this rule the button a menu
  // hangs from fades out under it. It sits inside @supports because the
  // minifier folds a bare rule into the hover rule's selector list (checked
  // with the build's own, 2026-10-10), and a browser without :has() drops a
  // whole list that names it: the hover rule would go with it.
  it("keeps a tile's controls on screen for as long as its menu is open", () => {
    const css = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');

    expect(css).toMatch(
      /@supports selector\(:has\(\*\)\) \{\s*\.group:has\(\[aria-haspopup="menu"\]\[aria-expanded="true"\]\) \.showcase-card-actions \{\s*opacity: 1;\s*\}\s*\}/,
    );
    // Nowhere else, and never beside another selector.
    expect(css.match(/\.group:has\(/g)).toHaveLength(1);
    expect(css).not.toMatch(/,\s*\.group:has\(|\.group:has\([^{]*,/);
  });

  it('leaves out the rows about the creator when there is no creator to act on', () => {
    render(
      <ShowcaseFeedbackMenu
        variant="inline"
        itemTitle="Campaign Frame"
        creator={{ username: 'fluffy', name: 'Fluffy' }}
        canHideCreator={false}
        onSelect={vi.fn()}
        onReportContent={vi.fn()}
        onReportUser={vi.fn()}
        onBlockUser={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));

    const rows = screen.getAllByRole('menuitem').map((row) => row.querySelector('.font-semibold')?.textContent);
    expect(rows).toEqual(['Not interested', 'Report content']);
  });

  // A creator's page and the viewer's saved posts are not feeds: there the
  // menu carries the safety rows alone, as the app's reel does.
  it('carries the safety rows alone where there is no feed to tune, with nothing to part them from', () => {
    const onReportContent = vi.fn();
    render(
      <ShowcaseFeedbackMenu
        itemTitle="Campaign Frame"
        creator={{ username: 'fluffy', name: 'Fluffy' }}
        onReportContent={onReportContent}
        onReportUser={vi.fn()}
        onBlockUser={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));

    const rows = screen.getAllByRole('menuitem').map((row) => row.querySelector('.font-semibold')?.textContent);
    expect(rows).toEqual(['Report content', 'Report user', 'Block user']);
    // The line parts the feed rows from the safety rows. With no feed rows it
    // would sit at the top of the menu, parting nothing.
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: /report content/i }));
    expect(onReportContent).toHaveBeenCalledTimes(1);
  });

  // A button that opens an empty menu is worse than no button: the viewer's
  // own post on a creator's page has no row that applies.
  it('draws nothing when no row applies', () => {
    const { container } = render(
      <ShowcaseFeedbackMenu
        itemTitle="Campaign Frame"
        creator={{ username: 'fluffy', name: 'Fluffy' }}
        canHideCreator={false}
        onReportUser={vi.fn()}
        onBlockUser={vi.fn()}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("sits among a creator page's outlined buttons, at their size and in their dress", () => {
    render(
      <ShowcaseFeedbackMenu
        variant="outline"
        portal
        itemTitle="@fluffy"
        creator={{ username: 'fluffy', name: 'Fluffy' }}
        onReportUser={vi.fn()}
        onBlockUser={vi.fn()}
      />
    );

    const trigger = screen.getByRole('button', { name: 'More actions for @fluffy' });
    // The Follow and Share buttons beside it: 44px tall, a hairline border on a faint fill.
    expect(trigger.className).toContain('h-11 w-11');
    expect(trigger.className).toContain('border-white/10 bg-white/[0.05]');
    // Not the tile's dress, which is made to sit on a picture.
    expect(trigger.className).not.toContain('bg-black/60');
    expect(trigger.className).not.toContain('h-12');

    fireEvent.click(trigger);
    const rows = screen.getAllByRole('menuitem').map((row) => row.querySelector('.font-semibold')?.textContent);
    expect(rows).toEqual(['Report user', 'Block user']);
    expect(screen.getByRole('menu').parentElement).toBe(document.body);
  });

  it('describes anonymous feedback as limited to the current visit', () => {
    render(
      <ShowcaseFeedbackMenu
        itemTitle="Campaign Frame"
        creator={{ username: 'creator-name', name: 'Creator Name' }}
        sessionOnly
        onSelect={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));
    expect(screen.getByRole('menuitem', { name: /not interested/i })).toHaveTextContent(/for this visit/i);
    expect(screen.getByRole('menuitem', { name: /hide @creator-name/i })).toHaveTextContent(/for this visit/i);
  });
});

// Feed ranking v4, §4 (docs/plans/feed-algorithm-v4-industry-parity-2026-10-12.md):
// a Home card reports how long it was read and how far its inline video
// played, and a card's resources opening, each credited to its delivery.
describe('feed card attention', () => {
  beforeEach(() => resetShowcaseFeedEventQueueForTests());
  afterEach(() => resetShowcaseFeedEventQueueForTests());

  it('reports one dwell per delivery, when a stretch of at least a second ends', () => {
    const attention = createFeedCardAttention({ deliveryId: 'delivery-1' });

    expect(attention.setQualified(true, 10_000)).toEqual([]);
    expect(attention.setQualified(false, 14_200)).toEqual([{ eventType: 'dwell', durationMs: 4_200 }]);

    // Read again: the delivery has reported its dwell.
    attention.setQualified(true, 20_000);
    expect(attention.setQualified(false, 30_000)).toEqual([]);

    // So has a card that mounts afresh for it (the windowed list, a lane revisited).
    const remounted = createFeedCardAttention({ deliveryId: 'delivery-1' });
    remounted.setQualified(true, 40_000);
    expect(remounted.end(45_000)).toEqual([]);

    // Another delivery of the same post is another dwell.
    const next = createFeedCardAttention({ deliveryId: 'delivery-2' });
    next.setQualified(true, 50_000);
    expect(next.end(52_500)).toEqual([{ eventType: 'dwell', durationMs: 2_500 }]);
  });

  it('reports nothing for a pass under a second, and lets a later stretch count', () => {
    const attention = createFeedCardAttention({ deliveryId: 'delivery-1' });

    attention.setQualified(true, 0);
    expect(attention.setQualified(false, 999)).toEqual([]);
    attention.setQualified(true, 2_000);
    expect(attention.setQualified(false, 3_500)).toEqual([{ eventType: 'dwell', durationMs: 1_500 }]);
  });

  it('caps a dwell at two minutes', () => {
    const attention = createFeedCardAttention({ deliveryId: 'delivery-1' });

    attention.setQualified(true, 0);
    expect(attention.setQualified(false, 10 * 60_000)).toEqual([{ eventType: 'dwell', durationMs: FEED_DWELL_MAX_MS }]);
    expect(FEED_DWELL_MAX_MS).toBe(120_000);
  });

  it('ends the stretch when the tab is hidden, and counts nothing while it is', () => {
    const attention = createFeedCardAttention({ deliveryId: 'delivery-1' });

    attention.setQualified(true, 0);
    expect(attention.pageHidden(400)).toEqual([]);
    // Back on the tab with the card still on screen: a new stretch from here.
    expect(attention.pageShown(60_000)).toEqual([]);
    expect(attention.setQualified(false, 61_600)).toEqual([{ eventType: 'dwell', durationMs: 1_600 }]);

    const hidden = createFeedCardAttention({ deliveryId: 'delivery-2', pageVisible: false });
    hidden.setQualified(true, 0);
    expect(hidden.end(5_000)).toEqual([]);
  });

  it('sends inline progress at each milestone and the rest when the card leaves view', () => {
    const attention = createFeedCardAttention({ deliveryId: 'delivery-1' });

    expect(attention.recordVideoProgress(0.1, 8_000)).toEqual([]);
    expect(attention.recordVideoProgress(0.3, 8_000)).toEqual([
      { eventType: 'media_progress', progress: 0.3, durationMs: 8_000 },
    ]);
    // A looping clip wraps to the start: the furthest point is kept.
    expect(attention.recordVideoProgress(0.05, 8_000)).toEqual([]);
    expect(attention.recordVideoProgress(0.4, 8_000)).toEqual([]);
    expect(attention.setQualified(false, 1_000)).toEqual([
      { eventType: 'media_progress', progress: 0.4, durationMs: 8_000 },
    ]);
    expect(attention.end(2_000)).toEqual([]);
    expect(attention.recordVideoProgress(1, 8_000)).toEqual([
      { eventType: 'media_progress', progress: 1, durationMs: 8_000 },
    ]);
  });

  it("measures a teaser's progress against the post's video, and an unknown length not at all", () => {
    // Four seconds into the eight-second head of a 95.5 s clip.
    expect(sourceVideoProgress({ currentTime: 4, streamDuration: 8, teaser: true, sourceDurationSeconds: 95.5 }))
      .toEqual({ progress: 4 / 95.5, durationMs: 95_500 });
    expect(sourceVideoProgress({ currentTime: 4, streamDuration: 8, teaser: true, sourceDurationSeconds: null })).toBeNull();
    // The whole clip streaming: its own length.
    expect(sourceVideoProgress({ currentTime: 6, streamDuration: 12, teaser: false, sourceDurationSeconds: 95.5 }))
      .toEqual({ progress: 0.5, durationMs: 12_000 });
    expect(sourceVideoProgress({ currentTime: 3, streamDuration: Number.NaN, teaser: false, sourceDurationSeconds: null })).toBeNull();
  });

  it('reports a card’s resources opening once per delivery, and never without one', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, recorded: 1, rejected: 0 })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const input = { item: createShowcaseItem(), sourceSurface: 'feed' as const, accessToken: 'token-1', feedSessionId: 'session-1', fallbackPosition: 2 };
      sendShowcaseResourceOpenEvent(input);
      sendShowcaseResourceOpenEvent(input);
      sendShowcaseResourceOpenEvent({ ...input, item: createShowcaseItem({ id: 'post-2', recommendation: undefined }) });
      await flushShowcaseFeedEvents();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(request.body))).toEqual({
        events: [expect.objectContaining({
          eventType: 'resource_open',
          deliveryId: 'delivery-1',
          postId: 'post-1',
          sourceSurface: 'feed',
          feedSessionId: 'session-1',
        })],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('QualifiedImpressionBoundary attention', () => {
  let observerCallback: IntersectionObserverCallback | null = null;
  let observedElement: Element | null = null;
  let visibility: DocumentVisibilityState = 'visible';
  // What the boundary hands the card inside it, read after render.
  const probe: { telemetry: FeedCardTelemetry | null } = { telemetry: null };

  function TelemetryProbe() {
    const telemetry = useFeedCardTelemetry();
    useEffect(() => {
      probe.telemetry = telemetry;
    }, [telemetry]);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T09:00:00.000Z'));
    resetShowcaseFeedEventQueueForTests();
    observerCallback = null;
    observedElement = null;
    probe.telemetry = null;
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }))));
    vi.stubGlobal('IntersectionObserver', vi.fn(function IntersectionObserverMock(
      callback: IntersectionObserverCallback
    ) {
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

  afterEach(() => {
    cleanupBoundary?.();
    cleanupBoundary = null;
    resetShowcaseFeedEventQueueForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState;
  });

  let cleanupBoundary: (() => void) | null = null;

  function renderAttentionBoundary(trackAttention = true) {
    const result = render(
      <QualifiedImpressionBoundary
        item={createShowcaseItem()}
        feedSessionId="session-1"
        accessToken="token-1"
        position={0}
        sourceSurface="feed"
        trackAttention={trackAttention}
      >
        <TelemetryProbe />
      </QualifiedImpressionBoundary>
    );
    cleanupBoundary = result.unmount;
    return result;
  }

  function reportVisibility(ratio: number) {
    observerCallback?.([{
      isIntersecting: ratio > 0,
      intersectionRatio: ratio,
      target: observedElement,
    } as IntersectionObserverEntry], {} as IntersectionObserver);
  }

  function sentEvents() {
    return vi.mocked(fetch).mock.calls.flatMap(([, init]) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { events?: Array<Record<string, unknown>> };
      return body.events ?? [body];
    });
  }

  it('sends the dwell of a card that leaves view, with its delivery', async () => {
    renderAttentionBoundary();

    act(() => {
      reportVisibility(0.8);
      vi.advanceTimersByTime(4_200);
      reportVisibility(0.2);
    });
    await act(async () => {
      await flushShowcaseFeedEvents();
    });

    expect(sentEvents()).toEqual([
      expect.objectContaining({ eventType: 'impression', deliveryId: 'delivery-1' }),
      expect.objectContaining({
        eventType: 'dwell',
        durationMs: 4_200,
        deliveryId: 'delivery-1',
        postId: 'post-1',
        sourceSurface: 'feed',
        feedSessionId: 'session-1',
        position: 7,
      }),
    ]);

    // On screen again and gone again: the delivery's dwell is already in.
    act(() => {
      reportVisibility(1);
      vi.advanceTimersByTime(5_000);
      reportVisibility(0);
    });
    await act(async () => {
      await flushShowcaseFeedEvents();
    });
    expect(sentEvents().filter((event) => event.eventType === 'dwell')).toHaveLength(1);
  });

  it('ends the stretch when the card unmounts', async () => {
    const { unmount } = renderAttentionBoundary();

    act(() => {
      reportVisibility(0.6);
      vi.advanceTimersByTime(3_000);
    });
    unmount();
    cleanupBoundary = null;
    await act(async () => {
      await flushShowcaseFeedEvents();
    });

    expect(sentEvents()).toContainEqual(expect.objectContaining({ eventType: 'dwell', durationMs: 3_000 }));
  });

  it('sends what the card was given at once when the tab is hidden', async () => {
    renderAttentionBoundary();

    act(() => {
      reportVisibility(1);
      vi.advanceTimersByTime(2_500);
    });
    vi.mocked(fetch).mockClear();
    await act(async () => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    // Flushed with the page going away, not two seconds later.
    expect(sentEvents()).toContainEqual(expect.objectContaining({ eventType: 'dwell', durationMs: 2_500 }));
  });

  it("passes a card's inline video progress through to its delivery", async () => {
    renderAttentionBoundary();
    expect(probe.telemetry).not.toBeNull();

    act(() => {
      probe.telemetry?.reportVideoProgress(0.1, 20_000);
      probe.telemetry?.reportVideoProgress(0.3, 20_000);
    });
    await act(async () => {
      await flushShowcaseFeedEvents();
    });

    expect(sentEvents()).toEqual([expect.objectContaining({
      eventType: 'media_progress',
      progress: 0.3,
      durationMs: 20_000,
      deliveryId: 'delivery-1',
      sourceSurface: 'feed',
    })]);
  });

  it("reports neither for the Explore grid's tiles", async () => {
    renderAttentionBoundary(false);
    expect(probe.telemetry).toBeNull();

    act(() => {
      reportVisibility(1);
      vi.advanceTimersByTime(6_000);
      reportVisibility(0);
    });
    await act(async () => {
      await flushShowcaseFeedEvents();
    });

    expect(sentEvents().map((event) => event.eventType)).toEqual(['impression']);
  });
});

// Undo for Not interested and Hide (product decision D7, 2026-10-14): a
// preference delete, sent with the bearer, after the hide it takes back.
describe('taking back Not interested and Hide', () => {
  const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  const requestedUrls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([url]) => String(url));

  afterEach(() => {
    vi.unstubAllGlobals();
    resetShowcaseFeedEventQueueForTests();
  });

  it('asks the undo route with the bearer, and reads whether a row went', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ ok: true, removed: true })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(undoShowcaseFeedFeedback('token-1', { feedbackType: 'hide_creator', creatorId: 'creator-1' }))
      .resolves.toEqual({ removed: true });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/showcase/feed/feedback/undo');
    expect(request?.method).toBe('POST');
    expect(request?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer token-1' }));
    expect(JSON.parse(String(request?.body))).toEqual({ feedbackType: 'hide_creator', creatorId: 'creator-1' });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, removed: false })));
    await expect(undoShowcaseFeedFeedback('token-1', { feedbackType: 'not_interested', postId: 'post-1' }))
      .resolves.toEqual({ removed: false });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
    await expect(undoShowcaseFeedFeedback('token-1', { feedbackType: 'not_interested', postId: 'post-1' }))
      .rejects.toThrow('401');
  });

  it("sends the undo once the hide's own request has settled, and nothing for a hide that was not stored", async () => {
    let answerHide: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(async (url: string) => (url === '/api/showcase/feed/events'
      ? new Promise<Response>((resolve) => { answerHide = resolve; })
      : new Response(JSON.stringify({ ok: true, removed: true }))));
    vi.stubGlobal('fetch', fetchMock);
    const target = { feedbackType: 'not_interested', postId: 'post-1' } as const;

    const hideRequest = sendShowcaseFeedEvent({
      item: createShowcaseItem(),
      eventType: 'not_interested',
      sourceSurface: 'feed',
      accessToken: 'token-1',
    }).then(() => true, () => false);
    // Sent at once, never held in the queue the watch events wait in.
    expect(requestedUrls(fetchMock)).toEqual(['/api/showcase/feed/events']);

    const undone = undoShowcaseFeedFeedbackAfterHide({ hideRequest, accessToken: 'token-1', target });
    await settle();
    // A delete beside the hide could land first and find nothing to take back.
    expect(requestedUrls(fetchMock)).toEqual(['/api/showcase/feed/events']);

    answerHide(new Response(JSON.stringify({ success: true })));
    await expect(undone).resolves.toBe(true);
    expect(requestedUrls(fetchMock)).toEqual(['/api/showcase/feed/events', '/api/showcase/feed/feedback/undo']);

    fetchMock.mockClear();
    await expect(undoShowcaseFeedFeedbackAfterHide({ hideRequest: Promise.resolve(false), accessToken: 'token-1', target }))
      .resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers false when the server kept the preference, or could not be asked', async () => {
    const target = { feedbackType: 'hide_creator', creatorId: 'creator-1' } as const;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, removed: false }))));
    await expect(undoShowcaseFeedFeedbackAfterHide({ hideRequest: Promise.resolve(true), accessToken: 'token-1', target }))
      .resolves.toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(undoShowcaseFeedFeedbackAfterHide({ hideRequest: Promise.resolve(true), accessToken: 'token-1', target }))
      .resolves.toBe(false);
  });

  it('puts removed posts back where they were', () => {
    const [first, second, third, fourth] = ['first', 'second', 'third', 'fourth'].map((id) => ({ id }));

    expect(putBackRemovedFeedItems([second, fourth], [{ item: first, index: 0 }, { item: third, index: 2 }]))
      .toEqual([first, second, third, fourth]);
    // One already back by another way stays where it is.
    expect(putBackRemovedFeedItems([first, second, fourth], [{ item: first, index: 0 }, { item: third, index: 2 }]))
      .toEqual([first, second, third, fourth]);
    // A list that got shorter meanwhile takes it at its end.
    expect(putBackRemovedFeedItems([first], [{ item: fourth, index: 3 }])).toEqual([first, fourth]);
  });

  it("offers Undo in the card's place, and takes the focus the card's menu took away with it", () => {
    const onUndo = vi.fn();
    render(<FeedRemovalUndoRow label="Posts from Creator Name hidden" onUndo={onUndo} />);

    expect(screen.getByRole('group', { name: 'Posts from Creator Name hidden' })).toHaveTextContent('Hidden · Undo');
    const undo = screen.getByRole('button', { name: 'Undo' });
    expect(undo).toHaveFocus();

    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('leaves the focus where the reader has put it', () => {
    const { rerender } = render(<button type="button">Elsewhere</button>);
    screen.getByRole('button', { name: 'Elsewhere' }).focus();

    rerender(
      <>
        <button type="button">Elsewhere</button>
        <FeedRemovalUndoRow label="Post hidden" onUndo={() => undefined} />
      </>
    );

    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
  });
});
