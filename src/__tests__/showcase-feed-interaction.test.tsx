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
