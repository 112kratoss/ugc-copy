'use client';

/* eslint-disable @next/next/no-html-link-for-pages -- Native links keep this demand shell independent of Next's interactive router chunk. */

import type { ComponentType, MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TrendingUp, X } from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
// A type alone: the full client's module is loaded with `import()` below, on demand.
import type { ShowcaseClientProps } from '@/app/showcase/ShowcaseClient';
import {
    EXPLORE_ACTIVE_FILTER_PILL_CLASS,
    EXPLORE_ACTIVE_FILTER_ROW_CLASS,
    exploreActiveFilters,
    type ExploreActiveFilter,
} from '@/app/showcase/explore-active-filters';
import { SHOWCASE_FEED_GRID_CLASS } from '@/app/showcase/showcase-layout';
import ReelHostMark from '@/components/ReelHostMark';
import { SearchEntryLink } from '@/components/search/SearchEntryLink';
import { buildOptimizedPreviewImageUrl } from '@/lib/preview-images';
import { pushReelEntry, replaceReelEntry } from '@/lib/reel-history-entry';
import { releaseReelOpening } from '@/lib/reel-opening-restore';
import {
    buildShowcaseClientCacheKey,
    filterFeedItemsForVisit,
    hasFreshShowcaseClientSnapshot,
} from '@/lib/showcase-client-cache';
import {
    SHOWCASE_INITIAL_RENDER_COUNT,
    type ShowcaseCategory,
    type ShowcaseFeedItem,
    type ShowcaseMediaItem,
    type ShowcasePriorityPosterData,
    type ShowcaseSort,
    getShowcaseItemMediaItems,
} from '@/lib/showcase';
import { isTextOnlyPost } from '@/lib/post-feed-presentation';
import {
    REMIX_CREDIT_CARD_TITLE_MAX_LENGTH,
    remixCreditLabel,
    remixCreditSegments,
    type RemixCredit,
} from '../../../ugc-mobile/lib/remix-credit/remix-credit';

// The page's props, passed on to the full client whole.
export type ShowcaseBootstrapClientProps = ShowcaseClientProps;

const CATEGORY_LINKS: Array<{ id: ShowcaseCategory; label: string }> = [
    { id: 'all', label: 'All posts' },
    { id: 'image', label: 'Images' },
    { id: 'video', label: 'Videos' },
];

const SORT_LINKS: Array<{ id: ShowcaseSort; label: string }> = [
    { id: 'for-you', label: 'For you' },
    { id: 'recent', label: 'Recent' },
    { id: 'top-saves', label: 'Saved' },
    { id: 'top-remixes', label: 'Remixed' },
    { id: 'top-sales', label: 'Sales' },
];

function setNonDefaultParam(
    params: URLSearchParams,
    key: string,
    value: string | null,
    defaultValue: string
) {
    if (value && value !== defaultValue) {
        params.set(key, value);
    }
}

/** The lane with another kind or sort, or with one of its other filters taken off (`cleared`). */
function buildFilterHref(
    props: ShowcaseBootstrapClientProps,
    nextCategory: ShowcaseCategory,
    nextSort: ShowcaseSort,
    cleared?: ExploreActiveFilter['key']
): string {
    const params = new URLSearchParams();
    setNonDefaultParam(params, 'category', nextCategory, 'all');
    setNonDefaultParam(params, 'sort', nextSort, 'for-you');
    setNonDefaultParam(params, 'tool', cleared === 'tool' ? null : props.initialTool, 'all');
    setNonDefaultParam(params, 'unlock', cleared === 'unlock' ? null : props.initialUnlock, 'all');
    setNonDefaultParam(params, 'resource', cleared === 'resource' ? null : props.initialResource, 'all');
    return params.size > 0 ? `/showcase?${params.toString()}` : '/showcase';
}


function getPriorityPosterUrl(
    item: ShowcaseFeedItem,
    cover: ShowcaseMediaItem | undefined,
    priorityPoster: ShowcasePriorityPosterData | null
): string | null {
    if (!cover) {
        return null;
    }

    if (priorityPoster?.postId === item.id && priorityPoster.mediaId === cover.id) {
        return priorityPoster.dataUrl;
    }

    const previewUrl = cover.previewUrl
        ?? (cover.mediaKind === 'image' ? cover.url : null);
    return previewUrl ? buildOptimizedPreviewImageUrl(previewUrl) : null;
}

/**
 * A plain left click is handled in-page by activating the full client; anything
 * the browser has its own meaning for — a new tab, a new window, a download,
 * a middle click — is left alone.
 */
function isPlainLeftClick(event: ReactMouseEvent): boolean {
    return event.button === 0
        && !event.metaKey
        && !event.ctrlKey
        && !event.shiftKey
        && !event.altKey;
}

function BootstrapCard({
    item,
    isPriority,
    priorityPoster,
    onOpen,
}: {
    item: ShowcaseFeedItem;
    isPriority: boolean;
    priorityPoster: ShowcasePriorityPosterData | null;
    onOpen: (postId: string) => void;
}) {
    const mediaItems = getShowcaseItemMediaItems(item);
    const cover = mediaItems.slice().sort((left, right) => left.sortOrder - right.sortOrder)[0];
    const posterUrl = getPriorityPosterUrl(item, cover, priorityPoster);
    // The canonical detail URL, matching what the sitemap emits — no `from` or
    // `returnTo` params, so the href a crawler follows is the one being indexed.
    const detailHref = `/showcase/${encodeURIComponent(item.id)}`;
    const openInPage = (event: ReactMouseEvent) => {
        if (!isPlainLeftClick(event)) {
            return;
        }

        event.preventDefault();
        onOpen(item.id);
    };

    return (
        <article
            data-showcase-bootstrap-card="true"
            className="min-w-0 overflow-hidden rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)]"
        >
            <div className="relative overflow-hidden bg-black" style={{ aspectRatio: '4 / 5' }}>
                {isPriority && posterUrl ? (
                    // The server-selected inline poster remains the single priority LCP image.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={posterUrl}
                        alt={item.title}
                        loading="eager"
                        fetchPriority="high"
                        decoding="async"
                        className="absolute inset-0 h-full w-full object-cover"
                    />
                ) : (
                    <div
                        className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,122,89,0.17),transparent_58%),var(--ui-surface-inset)]"
                        aria-hidden="true"
                    />
                )}
                <span className="pointer-events-none absolute left-3 top-3 z-[1] rounded-full border border-white/10 bg-black/65 px-2.5 py-1 text-[11px] font-semibold capitalize text-white">
                    {item.category}
                </span>
                <a
                    href={detailHref}
                    onClick={openInPage}
                    className="ui-focus-ring absolute inset-0 z-[2] h-full w-full"
                    aria-label={`Open ${item.title} in viewer`}
                />
            </div>

            <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                    <a
                        href={detailHref}
                        onClick={openInPage}
                        className="ui-focus-ring block max-w-full truncate rounded-lg text-left text-sm font-semibold text-zinc-100"
                    >
                        {item.title}
                    </a>
                    {item.creator.username ? (
                        <a
                            href={`/creators/${encodeURIComponent(item.creator.username)}`}
                            data-showcase-static-link="true"
                            className="ui-focus-ring mt-1 block min-h-6 max-w-full truncate rounded-lg text-xs font-semibold leading-6 text-zinc-300 hover:text-white"
                        >
                            {item.creator.name}
                        </a>
                    ) : (
                        <span className="mt-1 block truncate text-xs font-semibold leading-6 text-zinc-300">
                            {item.creator.name}
                        </span>
                    )}
                    {item.remixCredit ? <BootstrapRemixCredit credit={item.remixCredit} /> : null}
                </div>
                <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                    {item.category}
                </span>
            </div>
        </article>
    );
}

/**
 * A remix's credit on the shell's card (owner, 2026-11-05), in the full card's
 * words (`ugc-mobile/lib/remix-credit`) with this shell's native links.
 */
function BootstrapRemixCredit({ credit }: { credit: RemixCredit }) {
    return (
        <p
            data-testid="remix-credit"
            title={remixCreditLabel(credit)}
            className="mt-0.5 line-clamp-2 max-w-full text-[11px] leading-4 text-zinc-400"
        >
            {remixCreditSegments(credit, { titleMaxLength: REMIX_CREDIT_CARD_TITLE_MAX_LENGTH }).map((segment, index) => (
                segment.kind === 'text' ? (
                    <span key={index}>{segment.text}</span>
                ) : (
                    <a
                        key={index}
                        href={segment.kind === 'post'
                            ? `/showcase/${encodeURIComponent(segment.postId)}`
                            : `/creators/${encodeURIComponent(segment.username)}`}
                        data-showcase-static-link="true"
                        className="ui-focus-ring rounded-lg font-semibold text-zinc-200 hover:text-white"
                    >
                        {segment.text}
                    </a>
                )
            ))}
        </p>
    );
}

/** Browse recipes as the full client draws it (`BrowseRecipesLink`), a plain link until it takes over. */
function BrowseRecipesStaticLink({ className = '' }: { className?: string }) {
    return (
        <a
            href="/marketplace"
            data-showcase-static-link="true"
            className={`ui-focus-ring inline-flex min-h-12 items-center gap-2 whitespace-nowrap rounded-full border border-amber-300/20 bg-amber-400/10 px-5 text-sm font-bold text-amber-100 transition hover:border-amber-300/35 hover:bg-amber-400/15 ${className}`}
        >
            Browse recipes
        </a>
    );
}

function shouldDeferGlobalActivation(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest(
        '[data-showcase-static-link="true"], [data-showcase-bootstrap-card="true"]'
    ));
}

export default function ShowcaseBootstrapClient(props: ShowcaseBootstrapClientProps) {
    const { session, user, isLoading: isAuthLoading } = useAuth();
    // The full client, once its module has come.
    const [FullShowcaseClient, setFullShowcaseClient] = useState<ComponentType<ShowcaseClientProps> | null>(null);
    const hasFullClient = FullShowcaseClient !== null;
    const [isActivating, setIsActivating] = useState(false);
    const fullClientPromiseRef = useRef<Promise<ComponentType<ShowcaseClientProps>> | null>(null);
    // The post whose entry the last tap pushed over Explore's own entry while
    // the full client is on its way; null when nothing was pushed, or the tap
    // pushed over a shared link's entry. Only a second tap reads it: the full
    // client reads the entry itself (`reel-history-entry.ts`).
    const pushedPostIdRef = useRef<string | null>(null);
    const initialScrollYRef = useRef<number | null>(null);
    const shouldRelayAnonymousDemandRef = useRef(false);

    const loadFullClient = useCallback(() => {
        if (!fullClientPromiseRef.current) {
            fullClientPromiseRef.current = import('@/app/showcase/ShowcaseClient')
                .then((module) => module.default);
        }

        return fullClientPromiseRef.current;
    }, []);

    const activate = useCallback((postId?: string, relayAnonymousDemand = false) => {
        if (relayAnonymousDemand) {
            shouldRelayAnonymousDemandRef.current = true;
        }

        if (postId) {
            const params = new URLSearchParams(window.location.search);
            const currentPostId = params.get('post');
            params.set('post', postId);
            params.delete('media');
            const nextUrl = `/showcase?${params.toString()}`;
            if (pushedPostIdRef.current !== null && currentPostId === pushedPostIdRef.current) {
                // A second tap while the full client is still on its way, with
                // the address still on the entry the first tap pushed: that
                // entry is pointed at the new post, so two taps leave one entry,
                // still the reel's own.
                replaceReelEntry(nextUrl);
                pushedPostIdRef.current = postId;
            } else {
                // Only an entry pushed over Explore's own is the reel's own: the
                // full client, mounting on it, closes the reel by going Back to
                // Explore's. Pushed over a shared link's entry (the address named
                // a post before the tap), the reel closes by replacing, as
                // before, and the browser's Back then returns to the shared post.
                pushReelEntry(currentPostId ? null : 'post', nextUrl);
                pushedPostIdRef.current = currentPostId ? null : postId;
            }
        }

        setIsActivating(true);
        void loadFullClient().then((Component) => {
            setFullShowcaseClient(() => Component);
        }).catch(() => {
            fullClientPromiseRef.current = null;
            setIsActivating(false);
            // No reel opens without the full page: the grid shows, not the reel's stage.
            releaseReelOpening();
        });
    }, [loadFullClient]);

    useEffect(() => {
        initialScrollYRef.current = window.scrollY;

        if (new URLSearchParams(window.location.search).has('post')) {
            activate();
        }
    }, [activate]);

    useEffect(() => {
        if (!isAuthLoading && user && session?.access_token) {
            activate();
        }
    }, [activate, isAuthLoading, session?.access_token, user]);

    useEffect(() => {
        if (isAuthLoading || hasFullClient || isActivating) {
            return;
        }

        const cacheKey = buildShowcaseClientCacheKey({
            viewerId: user?.id ?? null,
            category: props.initialCategory,
            sort: props.initialSort,
            tool: props.initialTool,
            unlock: props.initialUnlock,
            resource: props.initialResource,
        });
        if (hasFreshShowcaseClientSnapshot(cacheKey)) {
            activate();
        }
    }, [
        hasFullClient,
        activate,
        isActivating,
        isAuthLoading,
        props.initialCategory,
        props.initialResource,
        props.initialSort,
        props.initialTool,
        props.initialUnlock,
        user?.id,
    ]);

    useEffect(() => {
        if (hasFullClient) {
            return;
        }

        const activateFromPointer = (event: PointerEvent) => {
            if (!shouldDeferGlobalActivation(event.target)) {
                activate(undefined, true);
            }
        };
        const activateFromKeyboard = (event: KeyboardEvent) => {
            if (!shouldDeferGlobalActivation(event.target)) {
                activate(undefined, true);
            }
        };
        const activateFromScroll = () => {
            const initialScrollY = initialScrollYRef.current ?? window.scrollY;
            if (Math.abs(window.scrollY - initialScrollY) >= 24) {
                activate(undefined, true);
            }
        };
        const activateFromGesture = () => activate(undefined, true);

        window.addEventListener('pointerdown', activateFromPointer, { passive: true });
        window.addEventListener('keydown', activateFromKeyboard);
        window.addEventListener('wheel', activateFromGesture, { passive: true, once: true });
        window.addEventListener('touchmove', activateFromGesture, { passive: true, once: true });
        window.addEventListener('scroll', activateFromScroll, { passive: true });

        return () => {
            window.removeEventListener('pointerdown', activateFromPointer);
            window.removeEventListener('keydown', activateFromKeyboard);
            window.removeEventListener('wheel', activateFromGesture);
            window.removeEventListener('touchmove', activateFromGesture);
            window.removeEventListener('scroll', activateFromScroll);
        };
    }, [hasFullClient, activate]);

    useEffect(() => {
        if (!hasFullClient || !shouldRelayAnonymousDemandRef.current) {
            return;
        }

        // Only relay a genuine interaction that happened while the bootstrap
        // owned the page. Idle/cache/auth handoffs may load the richer UI, but
        // must not manufacture anonymous personalization demand.
        shouldRelayAnonymousDemandRef.current = false;
        const handle = window.setTimeout(() => {
            window.dispatchEvent(new Event('showcase:demand'));
        }, 0);
        return () => window.clearTimeout(handle);
    }, [hasFullClient]);

    useEffect(() => {
        if (hasFullClient || isActivating || typeof IntersectionObserver === 'undefined') {
            return;
        }

        const sentinel = document.querySelector('[data-showcase-bootstrap-sentinel="true"]');
        if (!sentinel) {
            return;
        }

        let hasInitialObservation = false;
        const observer = new IntersectionObserver((entries) => {
            if (!hasInitialObservation) {
                hasInitialObservation = true;
                return;
            }

            if (entries.some((entry) => entry.isIntersecting)) {
                activate();
            }
        }, { rootMargin: '160px 0px' });
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [hasFullClient, activate, isActivating]);

    if (FullShowcaseClient) {
        return <FullShowcaseClient {...props} />;
    }

    // What this tab already knows this viewer's own feed leaves out (a creator
    // blocked a moment ago on another page, what the server answered the grid)
    // is not drawn here either, for the moment this shell stands in for the
    // grid. That knowledge lives in memory, so it is empty on any page the
    // server drew and the markup it sent still matches.
    const bootstrapItems = filterFeedItemsForVisit(props.initialFeed.items, {
        forYou: props.initialSort === 'for-you',
        viewerId: user?.id ?? null,
    })
        .filter((item) => !isTextOnlyPost(item))
        .slice(0, SHOWCASE_INITIAL_RENDER_COUNT);
    const priorityMediaItemId = bootstrapItems.find((item) => (
        getShowcaseItemMediaItems(item).length > 0
    ))?.id ?? null;
    const priorityPoster = props.initialPriorityPoster ?? null;
    const activeFilters = exploreActiveFilters({
        tool: props.initialTool,
        unlock: props.initialUnlock,
        resource: props.initialResource,
    }, props.sourceToolOptions);

    return (
        <div
            className="ui-page ui-page-ambient min-h-screen pt-3 pb-5 font-[family-name:var(--font-geist-sans)] sm:py-7"
            aria-busy={isActivating || undefined}
        >
            <ReelHostMark />
            <div className="studio-shell relative z-10">
                {/* As the full page draws it (ShowcaseClient): the shell hands over without a move.
                    Below 640px the search bar shares its row with Browse recipes, and the header is
                    the title alone, for screen readers. */}
                <div className="mb-3 flex items-center gap-2 sm:mb-5 lg:hidden">
                    <SearchEntryLink className="min-w-0 flex-1" />
                    <BrowseRecipesStaticLink className="shrink-0 sm:hidden" />
                </div>
                <header className="ui-enter flex flex-col gap-5 border-[var(--ui-border-subtle)] sm:mb-7 sm:border-b sm:pb-7 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        {/* The full page's icon: the eyebrow's line box takes its height from its
                            first item (a smaller dot drew it 3px taller). */}
                        <div className="mb-3 hidden items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ui-primary)] sm:inline-flex">
                            <TrendingUp className="h-3.5 w-3.5" />
                            Creator community
                        </div>
                        <h1 className="sr-only text-4xl font-extrabold tracking-[-0.035em] text-[var(--ui-text-primary)] sm:not-sr-only sm:text-5xl">
                            Explore
                        </h1>
                        <p className="mt-3 hidden max-w-2xl text-sm leading-6 text-[var(--ui-text-muted)] sm:block sm:text-base">
                            Fresh creator posts with optional recipes. Browse the result, then save it, remix it, or open the reusable process.
                        </p>
                    </div>
                    {/* As the client draws it (ShowcaseClient): a post starts from the top bar's Create menu. */}
                    <div className="hidden flex-wrap gap-2 sm:flex">
                        <BrowseRecipesStaticLink />
                    </div>
                </header>

                <nav
                    aria-label="Explore filters"
                    data-explore-filter-bar=""
                    className="sticky top-[calc(var(--app-shell-topbar-height)+0.5rem)] z-30 mb-3 rounded-4xl border border-[var(--ui-border-default)] bg-[rgba(25,25,28,0.92)] p-2 shadow-[0_12px_30px_rgba(0,0,0,0.24)] backdrop-blur-xl sm:mb-7 sm:p-4"
                >
                    <div className="flex flex-col gap-2 sm:gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div className="relative min-w-0 w-full sm:w-auto">
                          <div className="flex gap-2 overflow-x-auto pb-1 pr-12 sm:pb-0 sm:pr-0" aria-label="Filter posts by media type">
                            {CATEGORY_LINKS.map((category) => {
                                const isActive = props.initialCategory === category.id;
                                return (
                                    <a
                                        key={category.id}
                                        href={buildFilterHref(props, category.id, props.initialSort)}
                                        data-showcase-static-link="true"
                                        aria-current={isActive ? 'page' : undefined}
                                        className={`ui-focus-ring flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full border px-4 text-sm font-bold transition sm:min-h-12 ${isActive
                                            ? 'border-[var(--ui-primary-strong)] bg-[var(--ui-primary)] text-[var(--ui-primary-on)]'
                                            : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] text-[var(--ui-text-muted)] hover:border-[var(--ui-border-default)] hover:text-[var(--ui-text-primary)]'
                                        }`}
                                    >
                                        {category.label}
                                    </a>
                                );
                            })}
                          </div>
                          <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-[rgba(25,25,28,0.98)] to-transparent sm:hidden" />
                        </div>
                        <div className="flex gap-2 overflow-x-auto pb-1">
                            {SORT_LINKS.map((sort) => {
                                const isActive = props.initialSort === sort.id;
                                return (
                                    <a
                                        key={sort.id}
                                        href={buildFilterHref(props, props.initialCategory, sort.id)}
                                        data-showcase-static-link="true"
                                        aria-current={isActive ? 'page' : undefined}
                                        className={`ui-focus-ring inline-flex min-h-11 shrink-0 items-center rounded-full border px-3 text-xs font-bold transition ${isActive
                                            ? 'border-white/20 bg-white/10 text-white'
                                            : 'border-[var(--ui-border-subtle)] bg-[var(--ui-surface-inset)] text-[var(--ui-text-muted)] hover:text-white'
                                        }`}
                                    >
                                        {sort.label}
                                    </a>
                                );
                            })}
                        </div>
                    </div>
                    {/* The lane's filters past its kind and sort, as the full page draws them under its
                        controls, each a link to the lane without it: drawn when it takes over, the row
                        moved the grid down under a reader's scroll (web sweep, 2026-11-17). */}
                    {activeFilters.length > 0 ? (
                        <div data-explore-active-filters="" className={EXPLORE_ACTIVE_FILTER_ROW_CLASS}>
                            {activeFilters.map((filter) => (
                                <a
                                    key={filter.key}
                                    href={buildFilterHref(props, props.initialCategory, props.initialSort, filter.key)}
                                    data-showcase-static-link="true"
                                    className={EXPLORE_ACTIVE_FILTER_PILL_CLASS}
                                >
                                    {filter.label}
                                    <X className="h-3.5 w-3.5" />
                                </a>
                            ))}
                        </div>
                    ) : null}
                </nav>

                {bootstrapItems.length > 0 ? (
                    <div className={SHOWCASE_FEED_GRID_CLASS}>
                        {bootstrapItems.map((item) => (
                            <BootstrapCard
                                key={item.id}
                                item={item}
                                isPriority={item.id === priorityMediaItemId}
                                priorityPoster={priorityPoster}
                                onOpen={(postId) => activate(postId, true)}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-6 py-16 text-center text-[var(--ui-text-muted)]">
                        <p className="text-lg font-bold text-[var(--ui-text-primary)]">Nothing in this lane yet</p>
                        <p className="mt-2 text-sm">Choose another filter or share the first post.</p>
                    </div>
                )}

                <div
                    data-showcase-bootstrap-sentinel="true"
                    className="h-px w-full"
                    aria-hidden="true"
                />
            </div>
        </div>
    );
}
