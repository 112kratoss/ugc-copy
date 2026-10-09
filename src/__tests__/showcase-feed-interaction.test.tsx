import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  QualifiedImpressionBoundary,
  ShowcaseFeedbackMenu,
} from '@/app/showcase/ShowcaseFeedInteraction';
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
