'use client';

import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { ImageOff, Loader2, X } from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import { formatCompactCount } from '@/lib/post-feed-presentation';
import type { ShowcaseFeedItem } from '@/lib/showcase';

/**
 * A post's remix count, which opens its remixes (owner, 2026-11-05): the
 * remixes posted where anyone may see them, newest first, from
 * `GET /api/showcase/posts/:id/remixes`, which leaves out anyone the viewer is
 * blocked with, either way. The count holds every finished remix, posted or
 * not, so the list can be shorter than it, and says so.
 *
 * The browser's own modal dialog: it keeps focus inside, closes on Escape and
 * hands focus back to the count.
 */

type RemixesState = {
  items: ShowcaseFeedItem[];
  nextOffset: number | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
};

const PAGE_SIZE = 24;

function remixThumbnail(item: ShowcaseFeedItem): string | null {
  const cover = item.mediaItems?.[0];
  return cover?.previewUrl ?? (item.mediaKind === 'image' ? item.mediaUrl : null);
}

export default function PostRemixes({ postId, remixCount }: { postId: string; remixCount: number }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { session } = useAuth();
  const accessToken = session?.access_token ?? null;
  const [state, setState] = useState<RemixesState>({ items: [], nextOffset: 0, status: 'idle' });
  // A load the list's own button started: the button stays in its place, saying it is loading,
  // so focus is not dropped to the page while the read runs.
  const [loadingFromButton, setLoadingFromButton] = useState(false);

  const load = useCallback(async (offset: number) => {
    setState((current) => ({ ...current, status: 'loading' }));
    try {
      const response = await fetch(
        `/api/showcase/posts/${encodeURIComponent(postId)}/remixes?offset=${offset}&limit=${PAGE_SIZE}`,
        { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined },
      );
      if (!response.ok) throw new Error(`Remixes answered ${response.status}`);
      const body = await response.json() as {
        items?: ShowcaseFeedItem[];
        pageInfo?: { hasMore?: boolean; nextOffset?: number | null };
      };
      const page = Array.isArray(body.items) ? body.items : [];
      setState((current) => ({
        items: offset === 0 ? page : [...current.items, ...page.filter((item) => !current.items.some((kept) => kept.id === item.id))],
        nextOffset: body.pageInfo?.hasMore ? body.pageInfo.nextOffset ?? null : null,
        status: 'ready',
      }));
    } catch {
      setState((current) => ({ ...current, status: 'error' }));
    }
  }, [accessToken, postId]);

  const open = () => {
    dialogRef.current?.showModal();
    if (state.status === 'idle' || state.status === 'error') void load(0);
  };

  const runListAction = (offset: number) => {
    if (state.status === 'loading') return;
    setLoadingFromButton(true);
    void load(offset).finally(() => setLoadingFromButton(false));
  };
  const listAction = state.status === 'error'
    ? { label: 'Try again', offset: state.items.length > 0 ? state.nextOffset ?? 0 : 0 }
    : state.status === 'ready' && state.nextOffset !== null
      ? { label: 'Show more', offset: state.nextOffset }
      : state.status === 'loading' && loadingFromButton
        ? { label: 'Loading…', offset: null }
        : null;

  const label = `${formatCompactCount(remixCount)} ${remixCount === 1 ? 'remix' : 'remixes'}`;
  const unposted = state.status === 'ready' && state.nextOffset === null && state.items.length < remixCount;

  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-haspopup="dialog"
        className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full px-2 transition hover:text-white"
      >
        {label}
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={`post-remixes-${postId}`}
        onClick={(event) => {
          // A click on the backdrop lands on the dialog itself.
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
        className="m-auto max-h-[min(36rem,85vh)] w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-3xl border border-white/10 bg-[#0d0d10] p-0 text-white shadow-[0_24px_80px_rgba(0,0,0,0.6)] backdrop:bg-black/70"
      >
        <div className="flex max-h-[min(36rem,85vh)] flex-col">
          <div className="flex items-center justify-between gap-3 border-b border-white/8 px-5 py-4">
            <div>
              <h2 id={`post-remixes-${postId}`} className="text-base font-semibold">Remixes</h2>
              <p className="mt-0.5 text-xs text-zinc-500">Posted versions people made from this post</p>
            </div>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="Close remixes"
              className="ui-focus-ring inline-flex h-10 w-10 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {state.items.length > 0 ? (
              <ul className="space-y-1" data-testid="post-remixes-list">
                {state.items.map((item) => {
                  const thumbnail = remixThumbnail(item);
                  return (
                    <li key={item.id}>
                      <Link
                        href={`/showcase/${encodeURIComponent(item.id)}`}
                        prefetch={false}
                        className="ui-focus-ring flex items-center gap-3 rounded-2xl px-2 py-2 transition hover:bg-white/[0.05]"
                      >
                        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-zinc-900">
                          {thumbnail ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" />
                          ) : (
                            <ImageOff className="h-4 w-4 text-zinc-600" aria-hidden="true" />
                          )}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-zinc-100">{item.title}</span>
                          <span className="block truncate text-xs text-zinc-500">
                            {item.creator.username ? `@${item.creator.username}` : item.creator.name}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {state.status === 'loading' && !loadingFromButton ? (
              <p role="status" className="flex items-center justify-center gap-2 py-6 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Loading remixes…
              </p>
            ) : null}
            {state.status === 'error' ? (
              <p role="alert" className="px-2 pt-6 text-center text-sm text-rose-300">
                Couldn’t load remixes.
              </p>
            ) : null}
            {state.status === 'ready' && state.items.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-zinc-500">
                No remixes are posted yet. They show here once their creators post them.
              </p>
            ) : null}
            {unposted && state.items.length > 0 ? (
              <p className="px-2 pt-3 text-center text-xs text-zinc-500">Some remixes haven’t been posted.</p>
            ) : null}
            {/* One button for Show more and Try again, kept in place while the read it started runs. */}
            {listAction ? (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={() => { if (listAction.offset !== null) runListAction(listAction.offset); }}
                  aria-disabled={listAction.offset === null}
                  className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 px-4 text-xs font-semibold text-zinc-300 transition hover:bg-white/[0.06] hover:text-white aria-disabled:cursor-wait aria-disabled:opacity-70"
                >
                  {listAction.offset === null ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
                  {listAction.label}
                </button>
              </div>
            ) : null}
            {/* Says how many are listed once a page lands, for a screen reader that pressed the button. */}
            <p className="sr-only" aria-live="polite">
              {state.status === 'ready' && state.items.length > 0 ? `${state.items.length} ${state.items.length === 1 ? 'remix' : 'remixes'} listed` : ''}
            </p>
          </div>
        </div>
      </dialog>
    </>
  );
}
