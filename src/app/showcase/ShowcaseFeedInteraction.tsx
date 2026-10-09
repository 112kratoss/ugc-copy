'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Ban, EyeOff, Flag, MoreHorizontal, ShieldAlert, UserRoundX } from 'lucide-react';

import type { ShowcaseFeedItem, ShowcaseFeedPage } from '@/lib/showcase';

export type ShowcaseFeedbackAction = 'not_interested' | 'hide_creator';
export type ShowcaseFeedEventType =
  | 'impression'
  | 'open'
  | 'dwell'
  | 'media_progress'
  | 'quick_skip'
  | 'save'
  | 'unsave'
  | 'share'
  | 'remix_start'
  | ShowcaseFeedbackAction;
export type ShowcaseEventSourceSurface = 'showcase' | 'showcase-reel' | 'feed';

interface ShowcaseRecommendationMetadata {
  deliveryId?: string | null;
  position?: number | null;
  reason?: string | null;
  algorithmVersion?: string | null;
}

interface ShowcaseFeedEventInput {
  item: ShowcaseFeedItem;
  eventType: ShowcaseFeedEventType;
  sourceSurface: ShowcaseEventSourceSurface;
  accessToken?: string | null;
  feedSessionId?: string | null;
  fallbackPosition?: number;
  durationMs?: number;
  progress?: number;
  metadata?: Record<string, unknown>;
}

type RankedShowcaseFeedItem = ShowcaseFeedItem & {
  recommendation?: ShowcaseRecommendationMetadata | null;
};

type RankedShowcaseFeedPage = ShowcaseFeedPage & {
  feedSessionId?: string | null;
};

const DELIVERY_REQUIRED_EVENT_TYPES = new Set<ShowcaseFeedEventType>([
  'impression',
  'open',
  'dwell',
  'media_progress',
  'quick_skip',
  'share',
  'remix_start',
]);

function createClientEventId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `feed-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getShowcaseFeedSessionId(feed: ShowcaseFeedPage): string | null {
  const feedSessionId = (feed as RankedShowcaseFeedPage).feedSessionId;
  return typeof feedSessionId === 'string' && feedSessionId.length > 0 ? feedSessionId : null;
}

export function getShowcaseRecommendation(item: ShowcaseFeedItem): ShowcaseRecommendationMetadata | null {
  const recommendation = (item as RankedShowcaseFeedItem).recommendation;
  return recommendation && typeof recommendation === 'object' ? recommendation : null;
}

/**
 * Watching one reel to the end produces roughly seven events -- open,
 * impression, dwell and four progress milestones. Sent one per request that was
 * seven round trips, each re-running auth and a database-backed rate-limit write
 * for a single viewer watching a single clip. They are queued and flushed
 * together instead.
 *
 * Kept small and time-bounded: these feed live ranking signals, so holding them
 * for long would make the feed react late to what someone just watched.
 */
const FEED_EVENT_FLUSH_SIZE = 10;
const FEED_EVENT_FLUSH_DELAY_MS = 2_000;
/** Matches SHOWCASE_FEED_EVENT_BATCH_LIMIT, which the server enforces. */
const FEED_EVENT_MAX_BATCH = 25;

/**
 * Only pure telemetry is queued — precisely the events a watch session emits in
 * bulk, which is where the seven-requests-per-reel cost came from.
 *
 * Everything else changes state the UI reacts to and must stay synchronous. The
 * not-interested flow optimistically hides a post and restores it when this
 * request fails, so batching those would silently break the rollback: the send
 * would resolve before the server had said anything.
 */
const BATCHED_EVENT_TYPES = new Set<ShowcaseFeedEventType>([
  'impression',
  'open',
  'dwell',
  'media_progress',
  'quick_skip',
]);

type QueuedFeedEvent = { accessToken: string | null; body: Record<string, unknown> };

let pendingFeedEvents: QueuedFeedEvent[] = [];
let feedEventFlushTimer: ReturnType<typeof setTimeout> | null = null;
let feedEventUnloadBound = false;

function postFeedEvents(accessToken: string | null, body: unknown) {
  return fetch('/api/showcase/feed/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
    // A flush often happens as the page goes away; without this the browser
    // cancels it and a whole batch is lost rather than one event.
    keepalive: true,
  });
}

/**
 * Send everything queued now. Exported so a surface that is about to unmount,
 * or a test, can drain deterministically rather than waiting on the timer.
 */
export function flushShowcaseFeedEvents(): Promise<void> {
  if (feedEventFlushTimer !== null) {
    clearTimeout(feedEventFlushTimer);
    feedEventFlushTimer = null;
  }
  if (pendingFeedEvents.length === 0) return Promise.resolve();

  const queued = pendingFeedEvents;
  pendingFeedEvents = [];

  // One request carries one Authorization header, and a viewer can sign in or
  // out mid-session, so events travel with the token they were queued under.
  const byToken = new Map<string, QueuedFeedEvent[]>();
  for (const event of queued) {
    const key = event.accessToken ?? '';
    const bucket = byToken.get(key);
    if (bucket) bucket.push(event);
    else byToken.set(key, [event]);
  }

  const requests: Array<Promise<unknown>> = [];
  for (const bucket of byToken.values()) {
    for (let index = 0; index < bucket.length; index += FEED_EVENT_MAX_BATCH) {
      const chunk = bucket.slice(index, index + FEED_EVENT_MAX_BATCH);
      // Swallowed on purpose: these are telemetry, and the queue has already
      // released them, so there is nothing a caller could usefully retry.
      requests.push(postFeedEvents(chunk[0].accessToken, { events: chunk.map((entry) => entry.body) })
        .catch(() => undefined));
    }
  }

  return Promise.all(requests).then(() => undefined);
}

/**
 * The queue is module state, so it would otherwise leak across tests: events a
 * test queued and never flushed would ride along into the next one's assertions.
 */
export function resetShowcaseFeedEventQueueForTests() {
  if (feedEventFlushTimer !== null) {
    clearTimeout(feedEventFlushTimer);
    feedEventFlushTimer = null;
  }
  pendingFeedEvents = [];
}

function bindFeedEventUnloadFlush() {
  if (feedEventUnloadBound || typeof window === 'undefined') return;
  feedEventUnloadBound = true;

  // pagehide rather than unload: it fires for the back/forward cache, which
  // `unload` does not, and losing a watch session to a back navigation is the
  // common case on a feed.
  window.addEventListener('pagehide', () => { void flushShowcaseFeedEvents(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushShowcaseFeedEvents();
  });
}

export async function sendShowcaseFeedEvent({
  item,
  eventType,
  sourceSurface,
  accessToken,
  feedSessionId,
  fallbackPosition,
  durationMs,
  progress,
  metadata,
}: ShowcaseFeedEventInput): Promise<void> {
  const recommendation = getShowcaseRecommendation(item);
  if (DELIVERY_REQUIRED_EVENT_TYPES.has(eventType) && !recommendation?.deliveryId) {
    return;
  }
  const position = typeof recommendation?.position === 'number'
    ? recommendation.position
    : fallbackPosition;

  const body = {
    clientEventId: createClientEventId(),
    feedSessionId: feedSessionId ?? undefined,
    deliveryId: recommendation?.deliveryId ?? undefined,
    postId: item.id,
    eventType,
    position,
    durationMs,
    progress,
    sourceSurface,
    metadata: {
      ...(recommendation?.reason ? { recommendationReason: recommendation.reason } : {}),
      ...(recommendation?.algorithmVersion
        ? { algorithmVersion: recommendation.algorithmVersion }
        : {}),
      ...metadata,
    },
  };

  if (!BATCHED_EVENT_TYPES.has(eventType)) {
    // Sent as a bare event, not a one-item batch: the batch response reports a
    // rejected event inside a 200, and callers here depend on a non-ok status
    // to roll back optimistic UI.
    const response = await postFeedEvents(accessToken ?? null, body);
    if (!response.ok) {
      throw new Error(`Feed event request failed with ${response.status}`);
    }
    return;
  }

  bindFeedEventUnloadFlush();
  pendingFeedEvents.push({ accessToken: accessToken ?? null, body });

  if (pendingFeedEvents.length >= FEED_EVENT_FLUSH_SIZE) {
    await flushShowcaseFeedEvents();
    return;
  }

  if (feedEventFlushTimer === null) {
    feedEventFlushTimer = setTimeout(() => {
      feedEventFlushTimer = null;
      void flushShowcaseFeedEvents();
    }, FEED_EVENT_FLUSH_DELAY_MS);
  }
}

interface QualifiedImpressionBoundaryProps {
  item: ShowcaseFeedItem;
  feedSessionId?: string | null;
  accessToken?: string | null;
  position: number;
  /** Where the card is shown; the Home feed sends 'feed'. */
  sourceSurface?: ShowcaseEventSourceSurface;
  className?: string;
  children: ReactNode;
}

export function QualifiedImpressionBoundary({
  item,
  feedSessionId,
  accessToken,
  position,
  sourceSurface = 'showcase',
  className,
  children,
}: QualifiedImpressionBoundaryProps) {
  const boundaryRef = useRef<HTMLDivElement | null>(null);
  const sentImpressionKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const boundary = boundaryRef.current;
    if (!boundary || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const recommendation = getShowcaseRecommendation(item);
    const impressionKey = recommendation?.deliveryId ?? `${feedSessionId ?? 'unranked'}:${item.id}`;
    let qualificationTimer: ReturnType<typeof setTimeout> | null = null;

    const cancelQualification = () => {
      if (qualificationTimer) {
        clearTimeout(qualificationTimer);
        qualificationTimer = null;
      }
    };

    const observer = new IntersectionObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === boundary) ?? entries[0];
      const isQualifiedVisibility = Boolean(
        entry?.isIntersecting && entry.intersectionRatio >= 0.5
      );

      if (!isQualifiedVisibility) {
        cancelQualification();
        return;
      }

      if (sentImpressionKeyRef.current === impressionKey || qualificationTimer) {
        return;
      }

      qualificationTimer = setTimeout(() => {
        qualificationTimer = null;
        if (sentImpressionKeyRef.current === impressionKey) {
          return;
        }

        sentImpressionKeyRef.current = impressionKey;
        void sendShowcaseFeedEvent({
          item,
          eventType: 'impression',
          sourceSurface,
          accessToken,
          feedSessionId,
          fallbackPosition: position,
        }).catch((error) => {
          sentImpressionKeyRef.current = null;
          void error;
        });
      }, 1000);
    }, {
      threshold: [0.5],
    });

    observer.observe(boundary);

    return () => {
      cancelQualification();
      observer.disconnect();
    };
  }, [accessToken, feedSessionId, item, position, sourceSurface]);

  return (
    <div
      ref={boundaryRef}
      className={className}
      data-showcase-post-id={item.id}
    >
      {children}
    </div>
  );
}

interface ShowcaseFeedbackMenuProps {
  itemTitle: string;
  creatorName: string;
  canHideCreator?: boolean;
  sessionOnly?: boolean;
  onSelect: (action: ShowcaseFeedbackAction) => void | Promise<void>;
  /**
   * The safety rows the app's card menu carries (`ugc-mobile/lib/feed-feedback-menu.ts`),
   * each shown only when given. The two about the creator also need a creator
   * to act on (`canHideCreator`).
   */
  onReportContent?: () => void;
  onReportUser?: () => void;
  onBlockUser?: () => void;
  /** `overlay` sits on media (the grid tile); `inline` sits in a card header. */
  variant?: 'overlay' | 'inline';
  className?: string;
  buttonClassName?: string;
}

type FeedbackMenuRow = {
  key: string;
  label: string;
  description: string;
  Icon: typeof EyeOff;
  danger?: boolean;
  run: () => void;
};

// Room a row takes when the menu decides whether it fits below its trigger.
const FEEDBACK_MENU_ROW_HEIGHT = 60;

export function ShowcaseFeedbackMenu({
  itemTitle,
  creatorName,
  canHideCreator = true,
  sessionOnly = false,
  onSelect,
  onReportContent,
  onReportUser,
  onBlockUser,
  variant = 'overlay',
  className = '',
  buttonClassName = '',
}: ShowcaseFeedbackMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  // The inline menu is rendered into <body>: a feed card is paint-contained
  // (`content-visibility: auto`), which clips anything positioned past its
  // edge, and a short text post is shorter than the open menu. It opens below
  // its trigger, or above it when the screen has no room below.
  const [anchor, setAnchor] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const actionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const usesPortal = variant === 'inline';

  // The app's order and grouping: what to see less of, then safety.
  const rows: FeedbackMenuRow[] = [
    {
      key: 'not-interested',
      label: 'Not interested',
      description: sessionOnly ? 'Remove this post for this visit' : 'Show fewer posts like this',
      Icon: EyeOff,
      run: () => void onSelect('not_interested'),
    },
  ];
  if (canHideCreator) {
    rows.push({
      key: 'hide-creator',
      label: `Hide ${creatorName}`,
      description: sessionOnly ? 'Hide this creator for this visit' : 'Stop showing posts from this creator',
      Icon: UserRoundX,
      run: () => void onSelect('hide_creator'),
    });
  }
  if (onReportContent) {
    rows.push({ key: 'report-content', label: 'Report content', description: 'Send this post for a safety review', Icon: Flag, danger: true, run: onReportContent });
  }
  if (canHideCreator && onReportUser) {
    rows.push({ key: 'report-user', label: 'Report user', description: 'Ask moderators to review this creator', Icon: ShieldAlert, danger: true, run: onReportUser });
  }
  if (canHideCreator && onBlockUser) {
    rows.push({ key: 'block-user', label: 'Block user', description: 'Stop seeing their posts; no follows either way', Icon: Ban, danger: true, run: onBlockUser });
  }
  const actionCount = rows.length;

  const openMenu = () => {
    if (usesPortal && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const right = Math.max(8, window.innerWidth - rect.right);
      const needed = 16 + rows.length * FEEDBACK_MENU_ROW_HEIGHT;
      const spaceBelow = window.innerHeight - rect.bottom;
      setAnchor(spaceBelow < needed && rect.top > spaceBelow
        ? { bottom: window.innerHeight - rect.top + 8, right }
        : { top: rect.bottom + 8, right });
    }
    setIsOpen(true);
  };
  const triggerClassName = variant === 'inline'
    ? 'ui-focus-ring inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--ui-text-faint)] transition hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]'
    : 'ui-focus-ring inline-flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-black/60 text-white shadow-md backdrop-blur-md transition hover:bg-black/80';

  const focusAction = useCallback((index: number) => {
    const normalizedIndex = (index + actionCount) % actionCount;
    actionRefs.current[normalizedIndex]?.focus();
  }, [actionCount]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setIsOpen(false);
      }
    };
    // A portalled menu is pinned to where the trigger was; the page moving
    // under it would leave it floating, so it closes instead.
    const handleMove = () => {
      if (usesPortal) setIsOpen(false);
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setIsOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleEscape, true);
    window.addEventListener('scroll', handleMove, true);
    window.addEventListener('resize', handleMove);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape, true);
      window.removeEventListener('scroll', handleMove, true);
      window.removeEventListener('resize', handleMove);
    };
  }, [isOpen, usesPortal]);

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const activeIndex = actionRefs.current.findIndex((button) => button === document.activeElement);

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusAction(activeIndex + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusAction(activeIndex - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusAction(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusAction(actionCount - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
    }
  };

  const choose = (row: FeedbackMenuRow) => {
    setIsOpen(false);
    row.run();
  };

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Feedback actions for ${itemTitle}`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={handleMenuKeyDown}
      style={usesPortal && anchor ? anchor : undefined}
      className={`${usesPortal ? 'fixed' : 'absolute right-0 top-[calc(100%+0.5rem)]'} z-50 w-64 overflow-hidden rounded-2xl border border-white/10 bg-[rgba(24,24,27,0.98)] p-1.5 text-left shadow-[0_18px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl`}
    >
      {rows.map((row, index) => (
        <Fragment key={row.key}>
          {row.danger && !rows[index - 1]?.danger ? (
            <div role="separator" className="mx-2 my-1 h-px bg-white/10" />
          ) : null}
          <button
            ref={(node) => { actionRefs.current[index] = node; }}
            type="button"
            role="menuitem"
            onClick={() => choose(row)}
            className="ui-focus-ring flex min-h-12 w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-white/[0.07]"
          >
            <row.Icon className={`mt-0.5 h-4.5 w-4.5 shrink-0 ${row.danger ? 'text-[#ff7c8b]' : 'text-zinc-400'}`} aria-hidden />
            <span>
              <span className={`block text-sm font-semibold ${row.danger ? 'text-[#ff7c8b]' : 'text-zinc-100'}`}>{row.label}</span>
              <span className="mt-0.5 block text-xs leading-4 text-zinc-400">{row.description}</span>
            </span>
          </button>
        </Fragment>
      ))}
    </div>
  );

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`More actions for ${itemTitle}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={(event) => {
          event.stopPropagation();
          if (isOpen) setIsOpen(false); else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openMenu();
            window.requestAnimationFrame(() => focusAction(0));
          }
        }}
        className={`${triggerClassName} ${buttonClassName}`}
      >
        <MoreHorizontal className="h-5 w-5" aria-hidden />
      </button>

      {isOpen ? (usesPortal && anchor && typeof document !== 'undefined' ? createPortal(menu, document.body) : menu) : null}
    </div>
  );
}
