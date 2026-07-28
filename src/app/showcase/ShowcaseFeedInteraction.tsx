'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { EyeOff, MoreHorizontal, UserRoundX } from 'lucide-react';

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
export type ShowcaseEventSourceSurface = 'showcase' | 'showcase-reel';

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
  const response = await fetch('/api/showcase/feed/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({
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
    }),
    keepalive: true,
  });

  if (!response.ok) {
    throw new Error(`Feed event request failed with ${response.status}`);
  }
}

interface QualifiedImpressionBoundaryProps {
  item: ShowcaseFeedItem;
  feedSessionId?: string | null;
  accessToken?: string | null;
  position: number;
  className?: string;
  children: ReactNode;
}

export function QualifiedImpressionBoundary({
  item,
  feedSessionId,
  accessToken,
  position,
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
          sourceSurface: 'showcase',
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
  }, [accessToken, feedSessionId, item, position]);

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
  className?: string;
  buttonClassName?: string;
}

export function ShowcaseFeedbackMenu({
  itemTitle,
  creatorName,
  canHideCreator = true,
  sessionOnly = false,
  onSelect,
  className = '',
  buttonClassName = '',
}: ShowcaseFeedbackMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const actionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const actionCount = canHideCreator ? 2 : 1;

  const focusAction = useCallback((index: number) => {
    const normalizedIndex = (index + actionCount) % actionCount;
    actionRefs.current[normalizedIndex]?.focus();
  }, [actionCount]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
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
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [isOpen]);

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

  const selectAction = (action: ShowcaseFeedbackAction) => {
    setIsOpen(false);
    void onSelect(action);
  };

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
          setIsOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setIsOpen(true);
            window.requestAnimationFrame(() => focusAction(0));
          }
        }}
        className={`ui-focus-ring inline-flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-black/60 text-white shadow-md backdrop-blur-md transition hover:bg-black/80 ${buttonClassName}`}
      >
        <MoreHorizontal className="h-5 w-5" aria-hidden />
      </button>

      {isOpen ? (
        <div
          role="menu"
          aria-label={`Feedback actions for ${itemTitle}`}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleMenuKeyDown}
          className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-64 overflow-hidden rounded-2xl border border-white/10 bg-[rgba(24,24,27,0.98)] p-1.5 text-left shadow-[0_18px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl"
        >
          <button
            ref={(node) => { actionRefs.current[0] = node; }}
            type="button"
            role="menuitem"
            onClick={() => selectAction('not_interested')}
            className="ui-focus-ring flex min-h-12 w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left text-zinc-100 transition hover:bg-white/[0.07]"
          >
            <EyeOff className="mt-0.5 h-4.5 w-4.5 shrink-0 text-zinc-400" aria-hidden />
            <span>
              <span className="block text-sm font-semibold">Not interested</span>
              <span className="mt-0.5 block text-xs leading-4 text-zinc-400">
                {sessionOnly ? 'Remove this post for this visit' : 'Show fewer posts like this'}
              </span>
            </span>
          </button>
          {canHideCreator ? (
            <button
              ref={(node) => { actionRefs.current[1] = node; }}
              type="button"
              role="menuitem"
              onClick={() => selectAction('hide_creator')}
              className="ui-focus-ring flex min-h-12 w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left text-zinc-100 transition hover:bg-white/[0.07]"
            >
              <UserRoundX className="mt-0.5 h-4.5 w-4.5 shrink-0 text-zinc-400" aria-hidden />
              <span>
                <span className="block text-sm font-semibold">Hide {creatorName}</span>
                <span className="mt-0.5 block text-xs leading-4 text-zinc-400">
                  {sessionOnly ? 'Hide this creator for this visit' : 'Stop showing posts from this creator'}
                </span>
              </span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
