'use client';

import Link from 'next/link';
import { ChevronLeft, ChevronRight, Coins, Gift, Play, Send, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getAccentClasses, Text, type UiAccent } from '@/components/DesignSystem';
import { OptimizedPreviewImage } from '@/components/OptimizedPreviewImage';
import { useInlineMediaPlayback } from '@/components/useInlineMediaPlayback';
import { useMediaLoadingPreferences } from '@/components/useMediaLoadingPreferences';
import { CREATOR_TOOLS } from '@/lib/creator-tools';
import type { HomeShelfAction, HomeShelfCreation, HomeShelfItem } from '@/lib/home-shelf';
import {
  formatHomeShelfPrice,
  homeShelfActionCopy,
  homeShelfBadge,
  homeShelfCreatorLabel,
} from '@/lib/home-shelf-copy';

/**
 * The "Make this" shelf at the top of the home column (`home-shelf.ts` says
 * what goes in it, `home-shelf-copy.ts` what it says). A row that holds still:
 * three cards and a sliver of the fourth on a laptop, two and a sliver on a
 * phone, scrolled by touch, trackpad or the arrows. On a device with a mouse
 * the first clip card in view plays a muted preview, one clip on the page at a
 * time, never under Reduce Motion or Save-Data; a phone shows posters, and its
 * feed keeps the one clip that plays.
 */

const ACTION_LOOK: Record<HomeShelfAction['id'], { icon: LucideIcon; accent: UiAccent }> = {
  post: { icon: Send, accent: 'video' },
  invite: { icon: Gift, accent: 'commerce' },
  earn: { icon: Coins, accent: 'workflow' },
};

/** The tools the row ends on: the same catalogue as /create and the quick starts, without the canvas. */
const START_BLANK_TOOLS = CREATOR_TOOLS.filter((tool) => tool.id !== 'workflow');

/** A mouse or trackpad that hovers: where a preview can play without fighting the feed's own. */
function usePointerCanHover() {
  const [canHover, setCanHover] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(hover: hover) and (pointer: fine)');
    const sync = () => setCanHover(query.matches);
    sync();
    query.addEventListener?.('change', sync);
    return () => query.removeEventListener?.('change', sync);
  }, []);

  return canHover;
}

export default function HomeShelf({
  items,
  offerFreeToTry,
}: {
  items: HomeShelfItem[];
  /**
   * True on the signed-out home. "Free to try" promises the welcome credits,
   * which only someone without an account is still owed.
   */
  offerFreeToTry: boolean;
}) {
  if (items.length === 0) return null;

  return <HomeShelfRow items={items} offerFreeToTry={offerFreeToTry} />;
}

/**
 * The row's place, held while a signed-in member's shelf streams in, so the
 * feed below does not jump when it lands. Same classes, so the same size.
 */
export function HomeShelfPlaceholder() {
  return (
    <div className="home-shelf mb-6" aria-hidden>
      {/* The header: a 20px title over a 14px line. */}
      <div className="mb-3 h-13" />
      <div className="home-shelf-track">
        {[0, 1, 2, 3].map((slot) => (
          <div key={slot} className="home-shelf-item">
            <div className="home-shelf-card home-shelf-card--media bg-[var(--ui-surface-raised)]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function HomeShelfRow({ items, offerFreeToTry }: { items: HomeShelfItem[]; offerFreeToTry: boolean }) {
  const trackRef = useRef<HTMLUListElement | null>(null);
  const { prefersReducedMotion, saveData } = useMediaLoadingPreferences();
  const canHover = usePointerCanHover();
  const [canScroll, setCanScroll] = useState({ back: false, forward: false });
  const [playingId, setPlayingId] = useState<string | null>(null);
  const clipsAllowed = canHover && !prefersReducedMotion && !saveData;

  const syncScrollEnds = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    // A pixel of slack: fractional widths leave the end a hair short of it.
    const back = track.scrollLeft > 1;
    const forward = track.scrollLeft + track.clientWidth < track.scrollWidth - 1;
    // The same object while nothing changed, so a scroll does not re-render
    // every card at the scroll event's rate.
    setCanScroll((current) => (current.back === back && current.forward === forward ? current : { back, forward }));
  }, []);

  useEffect(() => {
    syncScrollEnds();
    window.addEventListener('resize', syncScrollEnds);
    return () => window.removeEventListener('resize', syncScrollEnds);
  }, [syncScrollEnds]);

  // The first clip card fully in view plays; scrolling hands the clip on. The
  // viewport is the root, so a shelf scrolled off the page plays nothing, and
  // the track's own overflow still clips what it measures.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || !clipsAllowed || typeof IntersectionObserver === 'undefined') return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.clipId;
        if (!id) continue;
        if (entry.intersectionRatio >= 0.6) visible.add(id);
        else visible.delete(id);
      }
      const first = [...track.querySelectorAll<HTMLElement>('[data-clip-id]')]
        .find((card) => visible.has(card.dataset.clipId ?? ''));
      setPlayingId(first?.dataset.clipId ?? null);
    }, { threshold: [0, 0.6, 1] });

    track.querySelectorAll('[data-clip-id]').forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [clipsAllowed, items]);

  const scrollByPage = (direction: 1 | -1) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollBy({
      left: direction * track.clientWidth * 0.9,
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    });
  };

  return (
    <section aria-labelledby="home-shelf-title" className="home-shelf mb-6">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <Text as="h2" variant="cardTitle">
            <span id="home-shelf-title">Make this</span>
          </Text>
          <Text variant="bodySm" className="truncate">Real creations, one tap to make your own</Text>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="home-shelf-arrows items-center gap-2">
            <button
              type="button"
              aria-label="Scroll the shelf back"
              disabled={!canScroll.back}
              onClick={() => scrollByPage(-1)}
              className="ui-icon-button ui-focus-ring disabled:opacity-35"
            >
              <ChevronLeft className="h-5 w-5" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Scroll the shelf forward"
              disabled={!canScroll.forward}
              onClick={() => scrollByPage(1)}
              className="ui-icon-button ui-focus-ring disabled:opacity-35"
            >
              <ChevronRight className="h-5 w-5" aria-hidden />
            </button>
          </div>
          <Link
            href="/showcase"
            prefetch={false}
            className="ui-focus-ring inline-flex min-h-12 items-center rounded-md px-1 text-sm font-bold text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
          >
            See all
          </Link>
        </div>
      </div>

      <ul ref={trackRef} className="home-shelf-track" onScroll={syncScrollEnds}>
        {items.map((item, index) => (
          <li key={`${item.kind}-${item.id}`} className="home-shelf-item">
            {item.kind === 'creation' ? (
              <CreationCard
                creation={item}
                offerFreeToTry={offerFreeToTry}
                // The row opens the page, so the posters a laptop shows first
                // are the page's largest paint: fetched at once, not lazily.
                eager={index < 3}
                // Checked here as well as in the observer: a preference that
                // changes mid-visit stops a clip already chosen.
                playing={clipsAllowed && playingId === item.id}
              />
            ) : (
              <ActionCard action={item} />
            )}
          </li>
        ))}
        <li className="home-shelf-item">
          <StartBlankTile />
        </li>
      </ul>
    </section>
  );
}

function CreationCard({
  creation,
  offerFreeToTry,
  eager,
  playing,
}: {
  creation: HomeShelfCreation;
  offerFreeToTry: boolean;
  eager: boolean;
  playing: boolean;
}) {
  // Registered with the page's one-clip rule: this clip starting pauses any
  // other preview, and the feed's starting pauses this one.
  const attachPlayback = useInlineMediaPlayback<HTMLVideoElement>();
  const badge = homeShelfBadge(creation, offerFreeToTry);
  const price = formatHomeShelfPrice(creation.price);
  const handle = homeShelfCreatorLabel(creation.creator);

  return (
    <Link
      href={creation.makeHref}
      prefetch={false}
      data-clip-id={creation.clipUrl ? creation.id : undefined}
      className="home-shelf-card home-shelf-card--media ui-focus-ring group border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-raised)]"
    >
      <OptimizedPreviewImage
        previewSrc={creation.posterUrl}
        alt=""
        sizes="(min-width: 40rem) 210px, 160px"
        loading={eager ? 'eager' : 'lazy'}
        className="object-cover transition duration-300 group-hover:scale-[1.03]"
      />
      {playing && creation.clipUrl ? (
        // Mounted only while it is the card in view, so the clip is fetched
        // for the one card someone is looking at and never for the rest. No
        // `poster`: until its first frame a video is transparent over the
        // optimized poster below, and a poster would fetch the full-size file.
        <video
          key={creation.clipUrl}
          ref={attachPlayback}
          src={creation.clipUrl}
          autoPlay
          muted
          loop
          playsInline
          preload="none"
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : null}
      <span className="absolute inset-0 bg-gradient-to-b from-black/[0.05] via-transparent to-black/75" aria-hidden />

      {badge ? (
        <span className="absolute left-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-xs font-bold text-white">
          {badge}
        </span>
      ) : null}
      {creation.clipUrl ? (
        <Play className="absolute right-2.5 top-2.5 h-4 w-4 text-white drop-shadow" aria-hidden />
      ) : null}

      <span className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 p-2.5">
        <span className="line-clamp-2 text-sm font-extrabold leading-snug text-white">{creation.title}</span>
        {creation.modelName || price ? (
          // A phone card has room for the price alone; the model name joins it
          // from 40rem (`.home-shelf-model`).
          <span className="truncate text-xs font-semibold text-white/80">
            {creation.modelName ? <span className="home-shelf-model">{creation.modelName}</span> : null}
            {creation.modelName && price ? <span className="home-shelf-model"> · </span> : null}
            {price}
          </span>
        ) : null}
        <span className="mt-1.5 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-xs font-semibold text-white/80">{handle}</span>
          <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-extrabold text-zinc-950">
            Make this
          </span>
        </span>
      </span>
    </Link>
  );
}

function ActionCard({ action }: { action: HomeShelfAction }) {
  const copy = homeShelfActionCopy(action);
  const look = ACTION_LOOK[action.id];
  const theme = getAccentClasses(look.accent);
  const Icon = look.icon;

  return (
    <Link
      href={copy.href}
      prefetch={false}
      className={`home-shelf-card home-shelf-card--stack ui-focus-ring border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] bg-gradient-to-br p-3 transition ${theme.surface} ${theme.border}`}
    >
      <span className={`flex h-9 w-9 items-center justify-center rounded-xl border ${theme.iconWrap}`}>
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-sm font-extrabold leading-5 text-[var(--ui-text-primary)]">{copy.title}</span>
        <span className="text-xs font-semibold leading-4 text-[var(--ui-text-muted)]">{copy.body}</span>
      </span>
      <span className={`w-fit rounded-full border px-2.5 py-1 text-xs font-extrabold ${theme.badge}`}>{copy.cta}</span>
    </Link>
  );
}

/** The row's last stop: the tools, for someone who would rather start from nothing. */
function StartBlankTile() {
  return (
    <div className="home-shelf-card home-shelf-card--stack border border-dashed border-[var(--ui-border-default)] p-3">
      <span className="flex flex-col gap-1">
        <span className="text-sm font-extrabold leading-5 text-[var(--ui-text-primary)]">Start from scratch</span>
        <span className="text-xs font-semibold leading-4 text-[var(--ui-text-muted)]">Pick a tool and write your own prompt.</span>
      </span>
      <span className="flex flex-col gap-1.5">
        {START_BLANK_TOOLS.map(({ shortLabel, href, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            prefetch={false}
            className="ui-focus-ring flex min-h-9 items-center gap-2 rounded-xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-2.5 text-xs font-bold text-[var(--ui-text-secondary)] transition hover:text-[var(--ui-text-primary)]"
          >
            <Icon className="h-4 w-4" aria-hidden />
            {shortLabel}
          </Link>
        ))}
      </span>
    </div>
  );
}
