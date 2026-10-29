'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, ChevronLeft, ChevronRight, Download, ExternalLink, EyeOff, Loader2, Play, RotateCcw, X } from 'lucide-react';

import { recipeMediaKind } from '@/app/showcase/recipe-reading';
import type { PostResourceItem } from '@/lib/post-resource-bundles';

interface RecipeMediaGalleryProps {
  /** A group's pictures, clips and sounds, in the creator's order. */
  items: PostResourceItem[];
  /** The group's name, which the full-screen view is called by. */
  title: string;
  /** Signs a stored file to be shown inline. Calls made in one tick share a request. */
  signUrl: (storagePath: string, signal?: AbortSignal) => Promise<string>;
  onDownload: (item: PostResourceItem) => void;
  /**
   * A mature post's pictures stay covered until the panel's one Show: the
   * plate is drawn above the grid, every tile keeps its name and download,
   * and nothing is signed or loaded under it.
   */
  coverPlate?: ReactNode;
  /** "Applies to 1 selected output", under a tile whose item is narrowed to some outputs. */
  scopeLabelFor?: (item: PostResourceItem) => string | null;
  className?: string;
}

/**
 * The server signs a recipe file for ten minutes
 * (`SIGNED_READ_EXPIRES_IN_SECONDS`, post-resource-file-url-service.ts). A
 * link is reused while it has this long of them left; an older one is
 * signed again before it is shown.
 */
const REUSE_SIGNED_URL_MS = 8 * 60 * 1000;

/** How long a thumbnail or the view waits for its link, as ResourceMediaPreview did, before offering Reload. */
const SIGNING_DEADLINE_MS = 30_000;

/** An inset outline: the tiles clip their corners, which would cut an outer focus ring. */
const TILE_FOCUS = 'outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--ui-focus)]';

type SignedLink = { url: string; at: number };

type ViewerItem = { key: string; url: string; kind: 'image' | 'video'; title: string };

type ViewerState = {
  items: ViewerItem[];
  index: number;
  /**
   * Where the view is drawn: the dialog the gallery sits in (the reel), or
   * the page. Drawn in place, it sat under the page's top bar: the post
   * column is a stacking context of its own.
   */
  host: HTMLElement;
};

function galleryItemKey(item: PostResourceItem, index: number): string {
  return item.id ?? `${item.type}:${item.storagePath ?? item.externalUrl ?? index}`;
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

/**
 * A recipe's pictures and clips as the app shows them: a grid of thumbnails
 * named the way the prompt names them ("@ali"), which open full screen, each
 * with its own download; a sound plays in place. They used to stack one
 * full-width preview over the next, each under its content type and two
 * buttons, about 330 px apiece.
 */
export default function RecipeMediaGallery({
  items,
  title,
  signUrl,
  onDownload,
  coverPlate = null,
  scopeLabelFor,
  className = '',
}: RecipeMediaGalleryProps) {
  const covered = coverPlate !== null;
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [attempt, setAttempt] = useState(0);
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  // A path is asked for once; one that failed, or whose request was dropped
  // when the effect re-ran before it answered, is asked for again.
  const requested = useRef(new Set<string>());
  // The thumbnails' links and when each was signed; and the links the view
  // signed afresh, kept for the next opening.
  const thumbnailLinks = useRef(new Map<string, SignedLink>());
  const viewLinks = useRef(new Map<string, SignedLink>());
  const rootRef = useRef<HTMLDivElement | null>(null);

  const storagePaths = useMemo(
    () => Array.from(new Set(items.map((item) => item.storagePath).filter((path): path is string => Boolean(path)))),
    [items],
  );
  const storagePathsKey = storagePaths.join('\n');

  useEffect(() => {
    // Nothing is signed under the cover; the links are asked for once it goes.
    if (covered) return;
    const requestedPaths = requested.current;
    const signedLinks = thumbnailLinks.current;
    const controller = new AbortController();
    const asked: string[] = [];
    const markFailed = (storagePath: string) => {
      requestedPaths.delete(storagePath);
      setFailed((current) => ({ ...current, [storagePath]: true }));
    };
    for (const storagePath of storagePaths) {
      if (requestedPaths.has(storagePath)) continue;
      requestedPaths.add(storagePath);
      asked.push(storagePath);
      const askedAt = Date.now();
      void signUrl(storagePath, controller.signal).then((url) => {
        if (controller.signal.aborted) return;
        signedLinks.set(storagePath, { url, at: askedAt });
        setUrls((current) => ({ ...current, [storagePath]: url }));
      }, () => {
        if (!controller.signal.aborted) markFailed(storagePath);
      });
    }
    // A request that never answers ends in Reload, not a spinner for good.
    const deadline = asked.length > 0
      ? setTimeout(() => {
          for (const storagePath of asked) {
            if (!signedLinks.has(storagePath)) markFailed(storagePath);
          }
        }, SIGNING_DEADLINE_MS)
      : null;
    return () => {
      controller.abort();
      if (deadline) clearTimeout(deadline);
      for (const storagePath of asked) {
        if (!signedLinks.has(storagePath)) requestedPaths.delete(storagePath);
      }
    };
    // storagePathsKey stands for storagePaths, whose identity follows `items`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [covered, signUrl, storagePathsKey, attempt]);

  const markFailed = (storagePath: string) => {
    thumbnailLinks.current.delete(storagePath);
    requested.current.delete(storagePath);
    setFailed((current) => ({ ...current, [storagePath]: true }));
  };

  const retry = (storagePath: string) => {
    setFailed((current) => {
      const next = { ...current };
      delete next[storagePath];
      return next;
    });
    setUrls((current) => {
      const next = { ...current };
      delete next[storagePath];
      return next;
    });
    setAttempt((value) => value + 1);
  };

  // What the full-screen view can show: stored pictures and clips. A sound
  // plays in its tile, and a link opens where it points.
  const viewable = items.flatMap((item, index) => {
    const kind = recipeMediaKind(item);
    return item.storagePath && (kind === 'image' || kind === 'video') ? [{ item, index, kind }] : [];
  });

  const openViewer = async (key: string) => {
    if (opening) return;
    setOpening(key);
    setViewerError(null);
    try {
      // A thumbnail's link opens the view from the browser's cache while it
      // has time left; the rest are signed afresh, together in one request,
      // and kept for the next opening.
      const now = Date.now();
      const fresh = (link: SignedLink | undefined) => (link && now - link.at < REUSE_SIGNED_URL_MS ? link.url : null);
      const links = await Promise.allSettled(viewable.map(({ item }) => {
        const path = item.storagePath as string;
        const reusable = fresh(thumbnailLinks.current.get(path)) ?? fresh(viewLinks.current.get(path));
        if (reusable) return Promise.resolve(reusable);
        return withDeadline(signUrl(path), SIGNING_DEADLINE_MS).then((url) => {
          viewLinks.current.set(path, { url, at: now });
          return url;
        });
      }));
      const viewerItems = viewable.flatMap(({ item, index, kind }, position): ViewerItem[] => {
        const link = links[position];
        return link.status === 'fulfilled'
          ? [{ key: galleryItemKey(item, index), url: link.value, kind: kind as 'image' | 'video', title: item.title }]
          : [];
      });
      const start = viewerItems.findIndex((entry) => entry.key === key);
      if (start < 0) {
        setViewerError('This file could not be opened. Try again.');
        return;
      }
      const host = rootRef.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body;
      setViewer({ items: viewerItems, index: start, host });
    } finally {
      setOpening(null);
    }
  };

  return (
    <div ref={rootRef} className={`@container ${className}`}>
      {coverPlate}
      {/* Columns follow the room the gallery has, not the window: in the reel's narrow rail four would be 59 px each. */}
      <ul className="grid grid-cols-2 gap-3 @lg:grid-cols-3 @2xl:grid-cols-4">
        {items.map((item, index) => {
          const key = galleryItemKey(item, index);
          const kind = recipeMediaKind(item);
          const storagePath = item.storagePath;
          const url = storagePath ? urls[storagePath] : null;
          const hasFailed = Boolean(storagePath && failed[storagePath]);

          let face;
          if (covered && storagePath) {
            face = (
              <div aria-hidden="true" className="flex aspect-[4/5] w-full items-center justify-center bg-zinc-950">
                <EyeOff className="h-5 w-5 text-zinc-600" />
              </div>
            );
          } else if (!storagePath) {
            face = item.externalUrl ? (
              <a
                href={item.externalUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${item.title}`}
                className={`flex aspect-[4/5] w-full flex-col items-center justify-center gap-2 bg-zinc-950 text-sm font-medium text-emerald-100 transition hover:bg-zinc-900 ${TILE_FOCUS}`}
              >
                <ExternalLink className="h-5 w-5" aria-hidden="true" />
                Open link
              </a>
            ) : (
              <div className="aspect-[4/5] w-full bg-zinc-950" />
            );
          } else if (hasFailed) {
            face = (
              <div role="alert" className="flex aspect-[4/5] w-full flex-col items-center justify-center gap-2 bg-zinc-950 px-3 text-center">
                <p className="text-xs text-zinc-400">Couldn’t load this {kind ?? 'file'}.</p>
                <button
                  type="button"
                  onClick={() => retry(storagePath)}
                  className={`inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 px-3 text-xs font-semibold text-zinc-100 transition hover:bg-white/[0.08] ${TILE_FOCUS}`}
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Reload
                </button>
              </div>
            );
          } else if (kind === 'audio') {
            // A sound plays in place, as the page's preview did before the gallery.
            face = (
              <div className="flex aspect-[4/5] w-full flex-col items-center justify-center gap-3 bg-zinc-950 px-2">
                <AudioLines className="h-6 w-6 text-emerald-100" aria-hidden="true" />
                {url ? (
                  <audio
                    src={url}
                    controls
                    preload="none"
                    aria-label={`Play ${item.title}`}
                    onError={() => markFailed(storagePath)}
                    className="w-full"
                  />
                ) : (
                  <Loader2 role="status" aria-label={`Loading ${item.title}`} className="h-5 w-5 animate-spin text-zinc-500 motion-reduce:animate-none" />
                )}
              </div>
            );
          } else {
            face = (
              <button
                type="button"
                onClick={() => void openViewer(key)}
                disabled={!url}
                aria-label={`View ${item.title}`}
                className={`group relative block aspect-[4/5] w-full overflow-hidden bg-zinc-950 disabled:cursor-wait ${TILE_FOCUS}`}
              >
                {url && kind === 'video' ? (
                  // The first frame stands in for a poster; `#t` makes Safari draw one.
                  <video
                    src={`${url}#t=0.1`}
                    muted
                    playsInline
                    preload="metadata"
                    aria-hidden="true"
                    onError={() => markFailed(storagePath)}
                    className="h-full w-full object-cover"
                  />
                ) : url ? (
                  // Loaded straight away: the link was signed for ten minutes,
                  // and a lazy picture scrolled to later would find it expired.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={url}
                    alt=""
                    onError={() => markFailed(storagePath)}
                    className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
                  />
                ) : (
                  <span role="status" aria-label={`Loading ${item.title}`} className="flex h-full w-full items-center justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-zinc-500 motion-reduce:animate-none" aria-hidden="true" />
                  </span>
                )}
                {url && kind === 'video' ? (
                  <span aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60 text-white backdrop-blur-sm">
                      <Play className="h-4 w-4 translate-x-px fill-current" />
                    </span>
                  </span>
                ) : null}
                {opening === key ? (
                  <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center bg-black/40">
                    <Loader2 className="h-5 w-5 animate-spin text-white motion-reduce:animate-none" />
                  </span>
                ) : null}
              </button>
            );
          }

          const scopeLabel = scopeLabelFor?.(item) ?? null;

          return (
            <li key={key} className="min-w-0 overflow-hidden rounded-xl border border-white/10 bg-black/40">
              {face}
              <div className="flex min-h-11 items-center gap-1 pl-3 pr-1">
                <span className="min-w-0 flex-1 py-1.5">
                  <span className="line-clamp-2 break-words text-sm font-medium leading-5 text-zinc-100" title={item.title}>
                    {item.title}
                  </span>
                  {item.description ? (
                    <span className="mt-0.5 line-clamp-2 break-words text-xs leading-4 text-zinc-400">{item.description}</span>
                  ) : null}
                  {scopeLabel ? <span className="block truncate text-xs text-emerald-100/70">{scopeLabel}</span> : null}
                </span>
                {storagePath ? (
                  <button
                    type="button"
                    onClick={() => onDownload(item)}
                    aria-label={`Download ${item.title}`}
                    className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-300 transition hover:bg-white/[0.08] hover:text-white ${TILE_FOCUS}`}
                  >
                    <Download className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {viewerError ? <p role="alert" className="mt-3 text-sm text-rose-200">{viewerError}</p> : null}
      {viewer ? (
        <RecipeMediaViewer
          title={title}
          items={viewer.items}
          startIndex={viewer.index}
          host={viewer.host}
          onClose={() => setViewer(null)}
        />
      ) : null}
    </div>
  );
}

const VIEWER_FOCUSABLE = 'button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

/**
 * The gallery's full-screen view. It draws the signed links as they are: the
 * feed's view sends pictures through the image optimizer, which would keep a
 * paid file for a day under a link signed for ten minutes. It answers its own
 * keys, wheel and swipes, so the reel under it does not page posts, and it
 * locks the page's scroll only when it is drawn over the page (the reel
 * already holds it).
 */
function RecipeMediaViewer({
  title,
  items,
  startIndex,
  host,
  onClose,
}: {
  title: string;
  items: ViewerItem[];
  startIndex: number;
  host: HTMLElement;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(startIndex);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Callers pass an inline arrow; the effect below stays mount-only.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const count = items.length;
  const current = items[Math.min(index, count - 1)];

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const lockScroll = host === document.body;
    const previousOverflow = document.body.style.overflow;
    if (lockScroll) document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => dialogRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        // The reel under the view pages posts on the arrows: they are the view's while it is open.
        event.stopPropagation();
        // A focused clip seeks with the side arrows.
        if (document.activeElement instanceof HTMLVideoElement) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          setIndex((value) => Math.max(0, Math.min(count - 1, value + (event.key === 'ArrowLeft' ? -1 : 1))));
        }
        return;
      }
      if (event.key === 'Tab' && dialog) {
        event.stopPropagation();
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(VIEWER_FOCUSABLE));
        if (focusable.length === 0) {
          event.preventDefault();
          dialog.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!dialog.contains(document.activeElement) || document.activeElement === dialog) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      if (lockScroll) document.body.style.overflow = previousOverflow;
      window.queueMicrotask(() => {
        if (previouslyFocused?.isConnected) previouslyFocused.focus();
      });
    };
  }, [count, host]);

  if (!current) return null;

  return createPortal(
    // A wheel or a swipe in the view is the view's: React hands a portal's
    // events to the gallery's parents, and the reel pages posts on both.
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overscroll-contain bg-black/90 p-4 backdrop-blur-sm sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
      onWheel={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-[min(96vw,1280px)] flex-col items-center justify-center gap-3 outline-none"
      >
        <button
          type="button"
          onClick={() => onCloseRef.current()}
          aria-label="Close media"
          className="ui-focus-ring absolute right-0 top-0 z-10 inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-black/70 text-zinc-200 backdrop-blur-md transition hover:border-white/25 hover:text-white"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="flex min-h-0 w-full flex-1 items-center justify-center">
          {current.kind === 'video' ? (
            <video key={current.key} src={current.url} controls playsInline className="max-h-full max-w-full rounded-xl" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={current.key} src={current.url} alt={current.title} className="max-h-full max-w-full rounded-xl object-contain" />
          )}
        </div>
        <div className="flex w-full items-center justify-center gap-3">
          {count > 1 ? (
            <button
              type="button"
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
              disabled={index === 0}
              aria-label="Previous"
              className="ui-focus-ring inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-black/60 text-zinc-100 transition hover:bg-white/10 disabled:opacity-40"
            >
              <ChevronLeft className="h-5 w-5" aria-hidden="true" />
            </button>
          ) : null}
          <p className="min-w-0 truncate text-sm font-medium text-zinc-100">
            {current.title}
            {count > 1 ? <span className="text-zinc-400">{` · ${index + 1} of ${count}`}</span> : null}
          </p>
          {count > 1 ? (
            <button
              type="button"
              onClick={() => setIndex((value) => Math.min(count - 1, value + 1))}
              disabled={index === count - 1}
              aria-label="Next"
              className="ui-focus-ring inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-black/60 text-zinc-100 transition hover:bg-white/10 disabled:opacity-40"
            >
              <ChevronRight className="h-5 w-5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    host,
  );
}
