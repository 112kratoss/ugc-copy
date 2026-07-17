'use client';

/* eslint-disable @next/next/no-html-link-for-pages -- Native links keep this demand shell independent of Next's interactive router chunk. */

import type { ComponentType } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/app/components/AuthProvider';
import { SHOWCASE_FEED_GRID_CLASS } from '@/app/showcase/showcase-layout';
import { buildOptimizedPreviewImageUrl } from '@/lib/preview-images';
import {
    buildShowcaseClientCacheKey,
    hasFreshShowcaseClientSnapshot,
} from '@/lib/showcase-client-cache';
import type {
    ShowcaseCategory,
    ShowcaseFeedItem,
    ShowcaseFeedPage,
    ShowcaseMediaItem,
    ShowcasePriorityPosterData,
    ShowcaseResourceFilter,
    ShowcaseSort,
    ShowcaseUnlockFilter,
} from '@/lib/showcase';
import type { SourceToolOption } from '@/lib/source-tools';

export interface ShowcaseBootstrapClientProps {
    initialFeed: ShowcaseFeedPage;
    initialCategory: ShowcaseCategory;
    initialSort: ShowcaseSort;
    initialTool: string | null;
    initialUnlock: ShowcaseUnlockFilter;
    initialResource: ShowcaseResourceFilter;
    sourceToolOptions: SourceToolOption[];
    initialPriorityPoster?: ShowcasePriorityPosterData | null;
}

const CATEGORY_LINKS: Array<{ id: ShowcaseCategory; label: string }> = [
    { id: 'all', label: 'All posts' },
    { id: 'image', label: 'Images' },
    { id: 'video', label: 'Videos' },
    { id: 'text', label: 'Tips' },
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

function buildFilterHref(
    props: ShowcaseBootstrapClientProps,
    nextCategory: ShowcaseCategory,
    nextSort: ShowcaseSort
): string {
    const params = new URLSearchParams();
    setNonDefaultParam(params, 'category', nextCategory, 'all');
    setNonDefaultParam(params, 'sort', nextSort, 'for-you');
    setNonDefaultParam(params, 'tool', props.initialTool, 'all');
    setNonDefaultParam(params, 'unlock', props.initialUnlock, 'all');
    setNonDefaultParam(params, 'resource', props.initialResource, 'all');
    return params.size > 0 ? `/showcase?${params.toString()}` : '/showcase';
}

function getItemMediaItems(item: ShowcaseFeedItem): ShowcaseMediaItem[] {
    if (item.mediaItems?.length) {
        return item.mediaItems;
    }

    if (!item.mediaUrl || !item.mediaKind) {
        return [];
    }

    return [{
        id: `${item.id}:cover`,
        url: item.mediaUrl,
        mediaKind: item.mediaKind,
        contentType: null,
        originalName: null,
        width: null,
        height: null,
        durationSeconds: null,
        sortOrder: 0,
    }];
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

function BootstrapCard({
    item,
    priorityPoster,
    onOpen,
}: {
    item: ShowcaseFeedItem;
    priorityPoster: ShowcasePriorityPosterData | null;
    onOpen: (postId: string) => void;
}) {
    const mediaItems = getItemMediaItems(item);
    const cover = mediaItems.slice().sort((left, right) => left.sortOrder - right.sortOrder)[0];
    const posterUrl = getPriorityPosterUrl(item, cover, priorityPoster);
    const summary = item.body.trim() || item.prompt.trim();

    return (
        <article
            data-showcase-bootstrap-card="true"
            className="min-w-0 overflow-hidden rounded-[1.5rem] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)]"
        >
            {item.postFormat === 'text' ? (
                <button
                    type="button"
                    onClick={() => onOpen(item.id)}
                    className="ui-focus-ring block min-h-64 w-full bg-[var(--ui-surface-inset)] p-6 text-left"
                    aria-label={`Open ${item.title} in viewer`}
                >
                    <span className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--ui-primary)]">
                        Creator tip
                    </span>
                    <span className="mt-4 block text-xl font-extrabold text-[var(--ui-text-primary)]">
                        {item.title}
                    </span>
                    {summary ? (
                        <span className="mt-3 line-clamp-5 block text-sm leading-6 text-[var(--ui-text-muted)]">
                            {summary}
                        </span>
                    ) : null}
                </button>
            ) : (
                <div className="relative overflow-hidden bg-black" style={{ aspectRatio: '4 / 5' }}>
                    {posterUrl ? (
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
                    <button
                        type="button"
                        onClick={() => onOpen(item.id)}
                        className="ui-focus-ring absolute inset-0 z-[2] h-full w-full"
                        aria-label={`Open ${item.title} in viewer`}
                    />
                </div>
            )}

            <div className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                    <button
                        type="button"
                        onClick={() => onOpen(item.id)}
                        className="ui-focus-ring block max-w-full truncate rounded-sm text-left text-sm font-semibold text-zinc-100"
                    >
                        {item.title}
                    </button>
                    {item.creator.username ? (
                        <a
                            href={`/creators/${encodeURIComponent(item.creator.username)}`}
                            data-showcase-static-link="true"
                            className="ui-focus-ring mt-1 block min-h-6 max-w-full truncate rounded-sm text-xs font-semibold leading-6 text-zinc-300 hover:text-white"
                        >
                            {item.creator.name}
                        </a>
                    ) : (
                        <span className="mt-1 block truncate text-xs font-semibold leading-6 text-zinc-300">
                            {item.creator.name}
                        </span>
                    )}
                </div>
                <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">
                    {item.category}
                </span>
            </div>
        </article>
    );
}

function shouldDeferGlobalActivation(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest(
        '[data-showcase-static-link="true"], [data-showcase-bootstrap-card="true"]'
    ));
}

export default function ShowcaseBootstrapClient(props: ShowcaseBootstrapClientProps) {
    const { session, user, isLoading: isAuthLoading } = useAuth();
    const [FullShowcaseClient, setFullShowcaseClient] = useState<ComponentType<ShowcaseBootstrapClientProps> | null>(null);
    const [isActivating, setIsActivating] = useState(false);
    const fullClientPromiseRef = useRef<Promise<ComponentType<ShowcaseBootstrapClientProps>> | null>(null);
    const initialScrollYRef = useRef<number | null>(null);

    const loadFullClient = useCallback(() => {
        if (!fullClientPromiseRef.current) {
            fullClientPromiseRef.current = import('@/app/showcase/ShowcaseClient')
                .then((module) => module.default as ComponentType<ShowcaseBootstrapClientProps>);
        }

        return fullClientPromiseRef.current;
    }, []);

    const activate = useCallback((postId?: string) => {
        if (postId) {
            const params = new URLSearchParams(window.location.search);
            params.set('post', postId);
            params.delete('media');
            window.history.pushState(null, '', `/showcase?${params.toString()}`);
        }

        setIsActivating(true);
        void loadFullClient().then((Component) => {
            setFullShowcaseClient(() => Component);
        }).catch(() => {
            fullClientPromiseRef.current = null;
            setIsActivating(false);
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
        if (isAuthLoading || FullShowcaseClient || isActivating) {
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
        FullShowcaseClient,
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
        if (FullShowcaseClient || isActivating) {
            return;
        }

        const activateFromPointer = (event: PointerEvent) => {
            if (!shouldDeferGlobalActivation(event.target)) {
                activate();
            }
        };
        const activateFromKeyboard = (event: KeyboardEvent) => {
            if (!shouldDeferGlobalActivation(event.target)) {
                activate();
            }
        };
        const activateFromScroll = () => {
            const initialScrollY = initialScrollYRef.current ?? window.scrollY;
            if (Math.abs(window.scrollY - initialScrollY) >= 24) {
                activate();
            }
        };
        const activateFromGesture = () => activate();

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
    }, [FullShowcaseClient, activate, isActivating]);

    useEffect(() => {
        if (!FullShowcaseClient) {
            return;
        }

        // The activating pointer/key/scroll happened before the full client
        // mounted. Relay that demand after its listeners are attached so the
        // anonymous feed session can be established during idle time.
        const handle = window.setTimeout(() => {
            window.dispatchEvent(new Event('showcase:demand'));
        }, 0);
        return () => window.clearTimeout(handle);
    }, [FullShowcaseClient]);

    useEffect(() => {
        if (FullShowcaseClient || isActivating || typeof IntersectionObserver === 'undefined') {
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
    }, [FullShowcaseClient, activate, isActivating]);

    if (FullShowcaseClient) {
        return <FullShowcaseClient {...props} />;
    }

    const firstItem = props.initialFeed.items[0] ?? null;
    const priorityPoster = props.initialPriorityPoster ?? null;

    return (
        <div
            className="ui-page ui-page-ambient min-h-screen py-5 font-[family-name:var(--font-geist-sans)] sm:py-7"
            aria-busy={isActivating || undefined}
        >
            <div className="studio-shell relative z-10">
                <header className="ui-enter mb-7 flex flex-col gap-5 border-b border-[var(--ui-border-subtle)] pb-7 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <div className="mb-3 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-[var(--ui-primary)]">
                            <span className="h-2 w-2 rounded-full bg-current" aria-hidden="true" />
                            Creator community
                        </div>
                        <h1 className="text-4xl font-extrabold tracking-[-0.035em] text-[var(--ui-text-primary)] sm:text-5xl">
                            Showcase
                        </h1>
                        <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--ui-text-muted)] sm:text-base">
                            Fresh creator posts with optional recipes. Browse the result, then save it, remix it, or open the reusable process.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <a
                            href="/post/new?from=community&returnTo=%2Fshowcase"
                            data-showcase-static-link="true"
                            className="ui-focus-ring inline-flex min-h-12 items-center gap-2 rounded-full bg-[var(--ui-primary)] px-5 text-sm font-extrabold text-[var(--ui-primary-on)] transition hover:bg-[var(--ui-primary-strong)] active:scale-[0.985]"
                        >
                            Share a post
                        </a>
                        <a
                            href="/marketplace"
                            data-showcase-static-link="true"
                            className="ui-focus-ring inline-flex min-h-12 items-center gap-2 rounded-full border border-amber-300/20 bg-amber-400/10 px-5 text-sm font-bold text-amber-100 transition hover:border-amber-300/35 hover:bg-amber-400/15"
                        >
                            Browse recipes
                        </a>
                    </div>
                </header>

                <nav
                    aria-label="Showcase filters"
                    className="sticky top-[72px] z-30 mb-7 rounded-[28px] border border-[var(--ui-border-default)] bg-[rgba(25,25,28,0.92)] p-3 shadow-[0_12px_30px_rgba(0,0,0,0.24)] backdrop-blur-xl sm:p-4"
                >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
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
                                        className={`ui-focus-ring flex min-h-12 shrink-0 items-center whitespace-nowrap rounded-full border px-4 text-sm font-bold transition ${isActive
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
                </nav>

                {firstItem ? (
                    <div className={SHOWCASE_FEED_GRID_CLASS}>
                        <BootstrapCard
                            item={firstItem}
                            priorityPoster={priorityPoster}
                            onOpen={activate}
                        />
                    </div>
                ) : (
                    <div className="rounded-[28px] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-6 py-16 text-center text-[var(--ui-text-muted)]">
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
