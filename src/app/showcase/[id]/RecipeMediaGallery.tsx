'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, Download, ExternalLink, EyeOff, Loader2, Play, RotateCcw } from 'lucide-react';

import FeedMediaLightbox from '@/app/feed/FeedMediaLightbox';
import { recipeMediaKind } from '@/app/showcase/recipe-reading';
import type { PostResourceItem } from '@/lib/post-resource-bundles';
import type { ShowcaseMediaItem } from '@/lib/showcase';

interface RecipeMediaGalleryProps {
  /** A group's pictures, clips and sounds, in the creator's order. */
  items: PostResourceItem[];
  /** The group's name, which the full-screen view is called by. */
  title: string;
  /** Signs a stored file to be shown inline. Calls made in one tick share a request. */
  signUrl: (storagePath: string, signal?: AbortSignal) => Promise<string>;
  onDownload: (item: PostResourceItem) => void;
  /** A sound plays in the browser's own player, in a new tab. */
  onOpenFile: (storagePath: string) => void;
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
 * A thumbnail's link is reused by the full-screen view while it has this long
 * left of its ten minutes, so the picture opens from the browser's cache; an
 * older one is signed again first.
 */
const REUSE_SIGNED_URL_MS = 8 * 60 * 1000;

type ViewerState = {
  mediaItems: ShowcaseMediaItem[];
  index: number;
  /**
   * Where the view is drawn: the dialog the gallery sits in (the reel), so
   * its focus stays inside it, or the page. Drawn in place, it sat under the
   * page's top bar: the post column is a stacking context of its own.
   */
  host: HTMLElement;
};

function galleryItemKey(item: PostResourceItem, index: number): string {
  return item.id ?? `${item.type}:${item.storagePath ?? item.externalUrl ?? index}`;
}

/**
 * A recipe's pictures and clips as the app shows them: a grid of thumbnails
 * named the way the prompt names them ("@ali"), which open full screen, each
 * with its own download. They used to stack one full-width preview over the
 * next, each under its content type and two buttons, about 330 px apiece.
 */
export default function RecipeMediaGallery({
  items,
  title,
  signUrl,
  onDownload,
  onOpenFile,
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
  const signed = useRef(new Set<string>());
  // When each thumbnail's link was signed, so the view knows which it may reuse.
  const signedAt = useRef(new Map<string, number>());
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
    const signedPaths = signed.current;
    const signedTimes = signedAt.current;
    const controller = new AbortController();
    const asked: string[] = [];
    for (const storagePath of storagePaths) {
      if (requestedPaths.has(storagePath)) continue;
      requestedPaths.add(storagePath);
      asked.push(storagePath);
      const askedAt = Date.now();
      void signUrl(storagePath, controller.signal).then((url) => {
        if (controller.signal.aborted) return;
        signedPaths.add(storagePath);
        signedTimes.set(storagePath, askedAt);
        setUrls((current) => ({ ...current, [storagePath]: url }));
      }, () => {
        if (controller.signal.aborted) return;
        requestedPaths.delete(storagePath);
        setFailed((current) => ({ ...current, [storagePath]: true }));
      });
    }
    return () => {
      controller.abort();
      for (const storagePath of asked) {
        if (!signedPaths.has(storagePath)) requestedPaths.delete(storagePath);
      }
    };
    // storagePathsKey stands for storagePaths, whose identity follows `items`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [covered, signUrl, storagePathsKey, attempt]);

  // The reel under the view pages posts with the up and down arrows; while
  // the view is open they are its. (Escape and the side arrows it answers itself.)
  useEffect(() => {
    if (!viewer) return;
    const holdArrows = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') event.preventDefault();
    };
    document.addEventListener('keydown', holdArrows);
    return () => document.removeEventListener('keydown', holdArrows);
  }, [viewer]);

  const markFailed = (storagePath: string) => {
    signed.current.delete(storagePath);
    signedAt.current.delete(storagePath);
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
  // plays in the browser, and a link opens where it points.
  const viewable = items.flatMap((item, index) => {
    const kind = recipeMediaKind(item);
    return item.storagePath && (kind === 'image' || kind === 'video') ? [{ item, index, kind }] : [];
  });

  const openViewer = async (item: PostResourceItem, key: string) => {
    if (opening) return;
    setOpening(key);
    setViewerError(null);
    try {
      // The thumbnails' links last ten minutes from when the page drew them.
      // While every one has time left the view opens on them, from the
      // browser's cache; otherwise it opens on fresh ones, signed together in
      // one request.
      const now = Date.now();
      const reusable = viewable.every(({ item: entry }) => {
        const path = entry.storagePath as string;
        const at = signedAt.current.get(path);
        return Boolean(urls[path]) && at !== undefined && now - at < REUSE_SIGNED_URL_MS;
      });
      const results = reusable
        ? viewable.map(({ item: entry }) => ({ status: 'fulfilled' as const, value: urls[entry.storagePath as string] }))
        : await Promise.allSettled(viewable.map(({ item: entry }) => signUrl(entry.storagePath as string)));
      const mediaItems = viewable.flatMap(({ item: entry, index, kind }, position): ShowcaseMediaItem[] => {
        const result = results[position];
        return result.status === 'fulfilled'
          ? [{
              id: galleryItemKey(entry, index),
              url: result.value,
              mediaKind: kind as 'image' | 'video',
              contentType: entry.contentType,
              originalName: entry.title,
              width: null,
              height: null,
              durationSeconds: null,
              sortOrder: position,
            }]
          : [];
      });
      const start = mediaItems.findIndex((media) => media.id === key);
      if (start < 0) {
        setViewerError('This file could not be opened. Try again.');
        return;
      }
      const host = rootRef.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body;
      setViewer({ mediaItems, index: start, host });
    } finally {
      setOpening(null);
    }
  };

  return (
    <div ref={rootRef} className={className}>
      {coverPlate}
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
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
                className="ui-focus-ring flex aspect-[4/5] w-full flex-col items-center justify-center gap-2 bg-zinc-950 text-sm font-medium text-emerald-100 transition hover:bg-zinc-900"
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
                  className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 px-3 text-xs font-semibold text-zinc-100 transition hover:bg-white/[0.08]"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Reload
                </button>
              </div>
            );
          } else if (kind === 'audio') {
            face = (
              <button
                type="button"
                onClick={() => onOpenFile(storagePath)}
                aria-label={`Play ${item.title}`}
                className="ui-focus-ring flex aspect-[4/5] w-full flex-col items-center justify-center gap-2 bg-zinc-950 text-sm font-medium text-emerald-100 transition hover:bg-zinc-900"
              >
                <AudioLines className="h-6 w-6" aria-hidden="true" />
                Play sound
              </button>
            );
          } else {
            face = (
              <button
                type="button"
                onClick={() => void openViewer(item, key)}
                disabled={!url}
                aria-label={`View ${item.title}`}
                className="ui-focus-ring group relative block aspect-[4/5] w-full overflow-hidden bg-zinc-950 disabled:cursor-wait"
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
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={url}
                    alt=""
                    loading="lazy"
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
                  {scopeLabel ? <span className="block truncate text-xs text-emerald-100/70">{scopeLabel}</span> : null}
                </span>
                {storagePath ? (
                  <button
                    type="button"
                    onClick={() => onDownload(item)}
                    aria-label={`Download ${item.title}`}
                    className="ui-focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-300 transition hover:bg-white/[0.08] hover:text-white"
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
      {viewer ? createPortal(
        // A wheel or a swipe in the view is the view's: React hands a portal's
        // events to the gallery's parents, and the reel pages posts on both.
        <div
          onWheel={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onTouchEnd={(event) => event.stopPropagation()}
        >
          <FeedMediaLightbox
            title={title}
            mediaItems={viewer.mediaItems}
            initialIndex={viewer.index}
            onClose={() => setViewer(null)}
          />
        </div>,
        viewer.host,
      ) : null}
    </div>
  );
}
