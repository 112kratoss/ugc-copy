'use client';

import Link from 'next/link';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { BookText, Heart, MessageCircle, Play } from 'lucide-react';

import { getAssetAccessLabel } from '@/lib/showcase-asset-labels';
import { getPostMadeWithLabel } from '@/lib/post-feed-presentation';
import { buildShowcaseDetailPath } from '@/lib/share';
import type { ShowcaseFeedItem, ShowcaseMediaItem } from '@/lib/showcase';
import { getUserInitials } from '@/lib/user-initials';

import {
  SEARCH_POST_REMIXABLE_BADGE,
  searchPostCardLabel,
  searchPostCreatorName,
  searchPostMadeWithLine,
} from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';

/**
 * Search's posts as Explore draws its posts: the picture over the post's
 * title, date, creator, what it was made with and its recipe badges, in a
 * wall where each picture keeps its own shape (Pinterest's results, which the
 * audit of 2026-11-13 set beside ours). Two across at a phone's width, three
 * and four as the page widens.
 *
 * Each card is one link to the post, named in words that hold everything it
 * shows. The wall keeps the cards in the order the search ranked them, in the
 * document and for the Tab key, and places each in the shortest column, as a
 * masonry wall does; the browser's own masonry (`grid-template-rows: masonry`)
 * is in no stable browser, and CSS columns would order the cards down each
 * column, so the order a person reads and the order the Tab key walks would
 * differ.
 */

const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The card's date, as Explore's card draws it: "Nov 12". */
export function searchPostCardDate(createdAt: string): string | null {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? null : DATE_FORMAT.format(date);
}

/** The narrowest and widest a picture is drawn, as width over height: a long strip is cropped to these. */
const TALLEST_RATIO = 9 / 16;
const WIDEST_RATIO = 16 / 9;
/** A picture whose size is not known is drawn at Explore's tile shape. */
const UNKNOWN_RATIO = 4 / 5;

function coverOf(item: ShowcaseFeedItem): ShowcaseMediaItem | null {
  return item.mediaItems?.slice().sort((a, b) => a.sortOrder - b.sortOrder)[0] ?? null;
}

/** The shape a card's picture is drawn at, width over height. */
export function searchPostCoverRatio(item: ShowcaseFeedItem): number {
  const cover = coverOf(item);
  if (!cover?.width || !cover.height) return UNKNOWN_RATIO;
  return Math.min(WIDEST_RATIO, Math.max(TALLEST_RATIO, cover.width / cover.height));
}

/** What a card shows besides its picture and title: one source for the card and its accessible name. */
export function searchPostCardFacts(item: ShowcaseFeedItem, viewerId: string | null = null) {
  const cover = coverOf(item);
  const video = (cover?.mediaKind ?? item.mediaKind) === 'video';
  const madeWith = getPostMadeWithLabel(item);
  const badges = [
    // "Your recipe" on the viewer's own, as Explore says it, in place of its price.
    ...(item.asset ? [getAssetAccessLabel(item.asset, { isOwner: Boolean(viewerId && item.creator.id === viewerId) })] : []),
    ...(item.canRemix ? [SEARCH_POST_REMIXABLE_BADGE] : []),
  ];
  return {
    cover,
    video,
    madeWith,
    badges,
    date: searchPostCardDate(item.createdAt),
    creatorName: searchPostCreatorName(item.creator),
  };
}

export function SearchPostCard({ item, returnTo, viewerId = null }: { item: ShowcaseFeedItem; returnTo: string; viewerId?: string | null }) {
  const { cover, video, madeWith, badges, date, creatorName } = searchPostCardFacts(item, viewerId);
  // The server leaves a video's preview empty until it has a poster; its media
  // URL is not a picture, so only an image falls back to it.
  const picture = cover?.previewUrl
    ?? (cover?.mediaKind === 'image' ? cover.url : null)
    ?? (!cover && item.mediaKind === 'image' ? item.mediaUrl : null);
  const textPost = !cover && !item.mediaUrl;
  return (
    <Link
      href={buildShowcaseDetailPath(item.id, { from: 'search', returnTo })}
      data-search-result="post"
      aria-label={searchPostCardLabel({
        title: item.title,
        creatorName,
        saveCount: item.saveCount,
        commentCount: item.commentCount,
        video,
        madeWith,
        badges,
        date,
      })}
      className="ui-focus-ring group block rounded-3xl"
    >
      <span className="relative block overflow-hidden rounded-3xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] transition duration-200 group-hover:border-[rgba(255,122,89,0.28)]">
        {textPost ? (
          <span className="flex min-h-40 flex-col justify-between gap-4 p-4">
            <BookText className="h-5 w-5 text-zinc-400" aria-hidden="true" />
            {/* The title is under the card, as on every card: here only the post's own words. */}
            {item.body || item.prompt ? <span className="line-clamp-6 text-sm leading-6 text-zinc-200">{item.body || item.prompt}</span> : null}
          </span>
        ) : (
          <span className="relative block bg-black" style={{ aspectRatio: searchPostCoverRatio(item) }}>
            {picture ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={picture}
                alt=""
                loading="lazy"
                decoding="async"
                className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-[1.015] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
              />
            ) : null}
            {video ? (
              <span className="absolute left-2.5 top-2.5 inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/10 bg-black/60 text-white backdrop-blur-md">
                <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              </span>
            ) : null}
          </span>
        )}
      </span>
      <span className="mt-2.5 flex flex-col gap-1 px-1.5">
        <span className="flex items-start justify-between gap-2">
          <span data-search-post-title="" className="line-clamp-1 flex-1 text-sm font-semibold leading-snug text-zinc-100">{item.title}</span>
          {date ? <span className="mt-0.5 whitespace-nowrap text-[11px] font-semibold text-zinc-400">{date}</span> : null}
        </span>
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            {item.creator.avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.creator.avatar} alt="" loading="lazy" className="h-5 w-5 shrink-0 rounded-full border border-white/10 object-cover" />
            ) : (
              <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[9px] font-semibold text-zinc-200">
                {getUserInitials(item.creator.name)}
              </span>
            )}
            <span className="truncate text-xs font-medium text-zinc-300">{creatorName}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2.5 text-[11px] font-semibold text-zinc-400">
            <span className="inline-flex items-center gap-1"><Heart className="h-3.5 w-3.5" aria-hidden="true" />{item.saveCount}</span>
            <span className="inline-flex items-center gap-1"><MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />{item.commentCount}</span>
          </span>
        </span>
        {madeWith ? <span className="truncate text-xs text-zinc-400">{searchPostMadeWithLine(madeWith)}</span> : null}
        {badges.length ? (
          <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
            {badges.map((badge) => (
              <span
                key={badge}
                className={badge === SEARCH_POST_REMIXABLE_BADGE
                  ? 'rounded-full border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-300'
                  : 'rounded-full border border-emerald-500/15 bg-emerald-500/[0.07] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-400'}
              >
                {badge}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

/** Columns for a wall of this width: two at a phone's, three and four as it widens. */
export function searchPostWallColumns(width: number): number {
  if (width >= 900) return 4;
  if (width >= 600) return 3;
  return 2;
}

/** The gap between cards: 12 px on a phone's width, 16 px above it. */
function wallGap(width: number): number {
  return width >= 600 ? 16 : 12;
}

type Placed = { x: number; y: number; width: number };

/**
 * Places cards of these heights, in their order, each in the column whose
 * bottom is highest so far (the leftmost of equals). A card added at the end
 * never moves one placed before it, so a page added with "Show more" leaves
 * what was on screen where it was.
 */
export function placeSearchPostWall(heights: readonly number[], width: number): { placed: Placed[]; height: number } {
  const columns = searchPostWallColumns(width);
  const gap = wallGap(width);
  const columnWidth = (width - gap * (columns - 1)) / columns;
  const bottoms = Array.from({ length: columns }, () => 0);
  const placed = heights.map((height) => {
    let column = 0;
    for (let index = 1; index < columns; index += 1) if (bottoms[index] < bottoms[column]) column = index;
    const at = { x: column * (columnWidth + gap), y: bottoms[column], width: columnWidth };
    bottoms[column] += height + gap;
    return at;
  });
  return { placed, height: Math.max(0, ...bottoms.map((bottom) => bottom - gap)) };
}

/**
 * The wall. Until the page's script has measured it, the cards stand in a
 * plain grid of the same columns (`data-wall="grid"`); once measured, each is
 * placed (`data-wall="placed"`) before the browser paints, and placed again
 * when the wall's width or a card's height changes (a font arriving, the
 * window narrowed). Nothing animates: a card is where it is.
 */
export function SearchPostWall({ items, returnTo, viewerId = null }: {
  items: readonly ShowcaseFeedItem[];
  returnTo: string;
  /** The account the answer was asked for: whose own recipes say "Your recipe". */
  viewerId?: string | null;
}) {
  const wallRef = useRef<HTMLDivElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const [layout, setLayout] = useState<{ width: number; heights: number[]; ids: string } | null>(null);
  const ids = items.map((item) => item.id).join('\n');

  const measure = useCallback(() => {
    const wall = wallRef.current;
    if (!wall) return;
    const width = wall.clientWidth;
    if (width <= 0) return;
    const heights = items.map((item) => cardRefs.current.get(item.id)?.offsetHeight ?? 0);
    setLayout((current) => (
      current && current.width === width && current.ids === ids && current.heights.every((height, index) => height === heights[index])
        ? current
        : { width, heights, ids }
    ));
  }, [ids, items]);

  // Measured in the commit that draws the cards, before the paint: the wall
  // never shows a frame with cards in the wrong place.
  useLayoutEffect(() => {
    measure();
    const wall = wallRef.current;
    if (!wall || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(wall);
    for (const card of cardRefs.current.values()) observer.observe(card);
    return () => observer.disconnect();
  }, [measure]);

  // A layout for the cards on show now, at the width it was measured at; the
  // width read again at each render, so a card is placed for the wall it is in.
  const measured = layout && layout.ids === ids ? layout : null;
  const wall = measured ? placeSearchPostWall(measured.heights, measured.width) : null;
  // Before the first measure, the same number of columns from the wall's own
  // width, as container queries read it.
  return (
    <div className="@container">
      <div
        ref={wallRef}
        data-wall={wall ? 'placed' : 'grid'}
        className={wall
          ? 'relative'
          : 'grid grid-cols-2 items-start gap-3 @min-[600px]:grid-cols-3 @min-[600px]:gap-4 @min-[900px]:grid-cols-4'}
        style={wall ? { height: wall.height } : undefined}
      >
        {items.map((item, index) => {
          const at = wall?.placed[index];
          return (
            <div
              key={item.id}
              ref={(element) => {
                if (element) cardRefs.current.set(item.id, element);
                else cardRefs.current.delete(item.id);
              }}
              className={at ? 'absolute left-0 top-0' : 'min-w-0'}
              style={at ? { width: at.width, transform: `translate(${at.x}px, ${at.y}px)` } : undefined}
            >
              <SearchPostCard item={item} returnTo={returnTo} viewerId={viewerId} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
