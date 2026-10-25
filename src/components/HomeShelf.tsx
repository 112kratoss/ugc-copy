'use client';

import Link from 'next/link';
import {
  ChevronLeft,
  ChevronRight,
  Coins,
  Gift,
  Image as ImageIcon,
  Play,
  Send,
  UserSquare2,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { getAccentClasses, type UiAccent } from '@/components/DesignSystem';
import { OptimizedPreviewImage } from '@/components/OptimizedPreviewImage';
import { useMediaLoadingPreferences } from '@/components/useMediaLoadingPreferences';
import type { HomeShelfAction, HomeShelfCreation, HomeShelfItem, HomeShelfPrice } from '@/lib/home-shelf';

/**
 * The "Make this" shelf at the top of the home column (`home-shelf.ts` says
 * what goes in it). A row that holds still: three cards and a sliver of the
 * fourth on a laptop, two and a sliver on a phone, scrolled by touch, trackpad
 * or the arrows. The movement is inside the cards: the first clip card in view
 * plays a muted preview, one at a time, never under Reduce Motion or Save-Data.
 */

const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** "15 credits", "Priced by clip length", or nothing when the price is unknown. */
export function formatHomeShelfPrice(price: HomeShelfPrice | null): string | null {
  if (!price) return null;
  if (price.kind === 'clip-length') return 'Priced by clip length';
  return `${price.credits} ${price.credits === 1 ? 'credit' : 'credits'}`;
}

type ActionCopy = {
  title: string;
  body: string;
  cta: string;
  href: string;
  icon: LucideIcon;
  accent: UiAccent;
};

export function homeShelfActionCopy(action: HomeShelfAction): ActionCopy {
  if (action.id === 'post') {
    return {
      title: 'Share your first post',
      body: 'Post a creation or a tip to the feed.',
      cta: 'Post now',
      href: '/post/new',
      icon: Send,
      accent: 'video',
    };
  }

  if (action.id === 'earn') {
    return {
      title: 'Earn from your prompts',
      body: `Add a recipe to a post, set a price, and keep ${percent.format(action.creatorSharePercent)}% of each sale.`,
      cta: 'Start selling',
      href: '/marketplace/sell',
      icon: Coins,
      accent: 'workflow',
    };
  }

  const yours = action.inviterPercent > 0
    ? `You get ${percent.format(action.inviterPercent)}% of their top-ups in credits.`
    : '';
  const theirs = action.inviteePercent > 0
    ? `They get ${percent.format(action.inviteePercent)}% extra on their first.`
    : '';
  return {
    title: 'Invite friends, earn credits',
    body: [yours, theirs].filter(Boolean).join(' '),
    cta: 'Invite friends',
    href: '/invite',
    icon: Gift,
    accent: 'commerce',
  };
}

const START_BLANK_TOOLS = [
  { label: 'Image', href: '/create-image', icon: ImageIcon },
  { label: 'Video', href: '/create-video', icon: Video },
  { label: 'Motion', href: '/create-motion', icon: UserSquare2 },
] as const;

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

function HomeShelfRow({ items, offerFreeToTry }: { items: HomeShelfItem[]; offerFreeToTry: boolean }) {
  const trackRef = useRef<HTMLUListElement | null>(null);
  const { prefersReducedMotion, saveData } = useMediaLoadingPreferences();
  const [canScroll, setCanScroll] = useState({ back: false, forward: false });
  const [playingId, setPlayingId] = useState<string | null>(null);
  const clipsAllowed = !prefersReducedMotion && !saveData;

  const syncScrollEnds = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    // A pixel of slack: fractional widths leave the end a hair short of it.
    setCanScroll({
      back: track.scrollLeft > 1,
      forward: track.scrollLeft + track.clientWidth < track.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    syncScrollEnds();
    window.addEventListener('resize', syncScrollEnds);
    return () => window.removeEventListener('resize', syncScrollEnds);
  }, [syncScrollEnds]);

  // The first clip card fully in view plays; scrolling hands the clip on. With
  // clips disallowed nothing is observed, and the render ignores any pick left.
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
    }, { root: track, threshold: [0, 0.6, 1] });

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
          <h2 id="home-shelf-title" className="text-base font-extrabold text-[var(--ui-text-primary)]">
            Make this
          </h2>
          <p className="truncate text-[13px] font-semibold text-[var(--ui-text-muted)]">
            Real creations, one tap to make your own
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="home-shelf-arrows items-center gap-2">
            <button
              type="button"
              aria-label="Scroll the shelf back"
              disabled={!canScroll.back}
              onClick={() => scrollByPage(-1)}
              className="ui-focus-ring flex h-8 w-8 items-center justify-center rounded-full border border-[var(--ui-border-default)] text-[var(--ui-text-secondary)] transition hover:text-[var(--ui-text-primary)] disabled:opacity-35"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Scroll the shelf forward"
              disabled={!canScroll.forward}
              onClick={() => scrollByPage(1)}
              className="ui-focus-ring flex h-8 w-8 items-center justify-center rounded-full border border-[var(--ui-border-default)] text-[var(--ui-text-secondary)] transition hover:text-[var(--ui-text-primary)] disabled:opacity-35"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
          <Link
            href="/showcase"
            prefetch={false}
            className="ui-focus-ring rounded-md text-[13px] font-bold text-[var(--ui-text-muted)] hover:text-[var(--ui-text-primary)]"
          >
            See all
          </Link>
        </div>
      </div>

      <ul ref={trackRef} className="home-shelf-track" onScroll={syncScrollEnds}>
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`} className="home-shelf-item">
            {item.kind === 'creation' ? (
              <CreationCard
                creation={item}
                offerFreeToTry={offerFreeToTry}
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
  playing,
}: {
  creation: HomeShelfCreation;
  offerFreeToTry: boolean;
  playing: boolean;
}) {
  const badge = creation.badge === 'new-model'
    ? 'New model'
    : offerFreeToTry && creation.fitsWelcomeCredits ? 'Free to try' : null;
  const price = formatHomeShelfPrice(creation.price);
  const handle = creation.creator.username ? `@${creation.creator.username}` : creation.creator.name;

  return (
    <Link
      href={creation.makeHref}
      prefetch={false}
      data-clip-id={creation.clipUrl ? creation.id : undefined}
      className="home-shelf-card ui-focus-ring group border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-raised)]"
    >
      <OptimizedPreviewImage
        previewSrc={creation.posterUrl}
        alt=""
        sizes="(min-width: 40rem) 210px, 150px"
        className="object-cover transition duration-300 group-hover:scale-[1.03]"
      />
      {playing && creation.clipUrl ? (
        // Mounted only while it is the card in view, so the clip is fetched
        // for the one card someone is looking at and never for the rest.
        <video
          key={creation.clipUrl}
          src={creation.clipUrl}
          poster={creation.posterUrl}
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
        <span className="absolute left-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-bold text-white">
          {badge}
        </span>
      ) : null}
      {creation.clipUrl ? (
        <Play className="absolute right-2.5 top-2.5 h-4 w-4 text-white drop-shadow" aria-hidden />
      ) : null}

      <span className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 p-2.5">
        <span className="line-clamp-2 text-[13px] font-extrabold leading-[1.25] text-white">{creation.title}</span>
        {creation.modelName || price ? (
          // A phone card has room for the price alone; the model name joins it
          // from 40rem (`.home-shelf-model`).
          <span className="truncate text-[11px] font-semibold text-white/80">
            {creation.modelName ? <span className="home-shelf-model">{creation.modelName}</span> : null}
            {creation.modelName && price ? <span className="home-shelf-model"> · </span> : null}
            {price}
          </span>
        ) : null}
        <span className="mt-1.5 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[11px] font-semibold text-white/80">{handle}</span>
          <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-[11px] font-extrabold text-zinc-950">
            Make this
          </span>
        </span>
      </span>
    </Link>
  );
}

function ActionCard({ action }: { action: HomeShelfAction }) {
  const copy = homeShelfActionCopy(action);
  const theme = getAccentClasses(copy.accent);
  const Icon = copy.icon;

  return (
    <Link
      href={copy.href}
      prefetch={false}
      className={`home-shelf-card ui-focus-ring flex flex-col justify-between border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] bg-gradient-to-br p-3 transition ${theme.surface} ${theme.border}`}
    >
      <span className={`flex h-9 w-9 items-center justify-center rounded-xl border ${theme.iconWrap}`}>
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-sm font-extrabold leading-[1.25] text-[var(--ui-text-primary)]">{copy.title}</span>
        <span className="text-xs font-semibold leading-[1.4] text-[var(--ui-text-muted)]">{copy.body}</span>
      </span>
      <span className={`w-fit rounded-full border px-2.5 py-1 text-[11px] font-extrabold ${theme.badge}`}>{copy.cta}</span>
    </Link>
  );
}

/** The row's last stop: the tools, for someone who would rather start from nothing. */
function StartBlankTile() {
  return (
    <div className="home-shelf-card flex flex-col justify-between border border-dashed border-[var(--ui-border-default)] p-3">
      <span className="flex flex-col gap-1">
        <span className="text-sm font-extrabold leading-[1.25] text-[var(--ui-text-primary)]">Start from scratch</span>
        <span className="text-xs font-semibold leading-[1.4] text-[var(--ui-text-muted)]">Pick a tool and write your own prompt.</span>
      </span>
      <span className="flex flex-col gap-1.5">
        {START_BLANK_TOOLS.map(({ label, href, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            prefetch={false}
            className="ui-focus-ring flex min-h-9 items-center gap-2 rounded-xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] px-2.5 text-xs font-bold text-[var(--ui-text-secondary)] transition hover:text-[var(--ui-text-primary)]"
          >
            <Icon className="h-4 w-4" aria-hidden />
            {label}
          </Link>
        ))}
      </span>
    </div>
  );
}
