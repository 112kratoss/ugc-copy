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
        creatorName="Creator Name"
        onSelect={onSelect}
      />
    );

    const trigger = screen.getByRole('button', { name: /more actions for campaign frame/i });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    act(() => vi.advanceTimersByTime(20));

    expect(screen.getByRole('menu', { name: /feedback actions/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /not interested/i })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole('menuitem', { name: /not interested/i }), { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: /hide creator name/i })).toHaveFocus();

    fireEvent.click(screen.getByRole('menuitem', { name: /hide creator name/i }));
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
        creatorName="Creator Name"
        canHideCreator={false}
        onSelect={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));

    expect(screen.getByRole('menuitem', { name: /not interested/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /hide creator name/i })).not.toBeInTheDocument();
  });

  it('describes anonymous feedback as limited to the current visit', () => {
    render(
      <ShowcaseFeedbackMenu
        itemTitle="Campaign Frame"
        creatorName="Creator Name"
        sessionOnly
        onSelect={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions for campaign frame/i }));
    expect(screen.getByRole('menuitem', { name: /not interested/i })).toHaveTextContent(/for this visit/i);
    expect(screen.getByRole('menuitem', { name: /hide creator name/i })).toHaveTextContent(/for this visit/i);
  });
});
