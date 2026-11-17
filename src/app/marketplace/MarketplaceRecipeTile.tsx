import { useCallback, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { Play, ShoppingBag } from 'lucide-react';

import {
  getMarketplaceCardAccess,
  type MarketplaceViewerState,
} from '@/app/marketplace/marketplace-card-access';
import { SHOWCASE_FEED_GRID_CLASS } from '@/app/showcase/showcase-layout';
import CreatorIdentity from '@/components/CreatorIdentity';
import { HoverVideo } from '@/components/HoverVideo';
import { OptimizedPreviewImage } from '@/components/OptimizedPreviewImage';
import TextPostPreviewCard from '@/components/TextPostPreviewCard';
import { resolvePlaybackUrl } from '@/lib/media-descriptor';
import { formatUnlockCountLabel, getPostResourceKindLabel } from '@/lib/post-resource-bundles';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

/**
 * Explore's grid, so a recipe sits in the same place and at the same size as
 * the post it came from: four across on a laptop, one on a phone, where it
 * sits closer under the filters so the first screen reaches it.
 */
export const MARKETPLACE_RECIPE_GRID_CLASS = `mt-6 sm:mt-10 ${SHOWCASE_FEED_GRID_CLASS}`;

// The tile's share of the page at each of the grid's widths.
const TILE_IMAGE_SIZES = '(min-width: 1280px) 25vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw';

// The first page is drawn on the server, so the date is the same day there and
// in every browser, as Explore's is.
const TILE_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export interface MarketplaceRecipeTileLinkProps {
  href: string;
  className: string;
  'aria-label': string;
  children: ReactNode;
}

interface MarketplaceRecipeTileProps {
  asset: MarketplaceResourceListItem;
  /** The signed-in viewer's recipes (`useViewerRecipeState`): theirs read "Unlocked" or "Your recipe". */
  viewer: MarketplaceViewerState;
  href: string;
  /** `next/link` in the interactive list, a plain anchor in the first-paint shell. */
  linkComponent?: 'a' | ComponentType<MarketplaceRecipeTileLinkProps>;
}

/**
 * One recipe, drawn as Explore draws a post (`ShowcaseGridCard`): the post's
 * cover in a 4:5 frame, and under it the title and date, the creator, and the
 * recipe's price and kinds. The shell and the interactive list both draw this,
 * so nothing moves when the list takes over. The whole tile is one link to the
 * post, which is why the creator row has no link of its own here.
 *
 * The frame is a surface of its own, not black, while its picture is on its
 * way (owner's recording, 2026-11-16: a recipe "Load more" brought stayed solid
 * black until its picture came).
 */
export function MarketplaceRecipeTile({
  asset,
  viewer,
  href,
  linkComponent: LinkComponent = 'a',
}: MarketplaceRecipeTileProps) {
  // The chip prices it in credits, as every other chip does (audit B-F13), or
  // says "Free recipe", "Unlocked" or "Your recipe"; the unlock action names
  // every way to pay, as the post's panel does.
  const { accessLabel, unlockLabel } = getMarketplaceCardAccess(asset, viewer);
  const postTitle = asset.post?.title?.trim() || asset.title;
  const isClip = Boolean(asset.post?.mediaUrl) && asset.post?.mediaKind === 'video';
  // "N opened" counts free unlocks, "N sold" paid ones (decision 6, 2026-10-17).
  const unlockCountLabel = formatUnlockCountLabel(
    asset.accessMode,
    asset.accessMode === 'free' ? asset.freeUnlockCount : asset.salesCount,
  );

  return (
    <LinkComponent
      href={href}
      aria-label={`${unlockLabel}: ${postTitle}`}
      className="group ui-focus-ring flex min-w-0 flex-col rounded-ui-2xl"
    >
      <div className="relative aspect-[4/5] overflow-hidden rounded-ui-2xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] transition duration-200 group-hover:border-[rgba(255,122,89,0.28)] group-hover:shadow-[var(--ui-shadow-card-hover)]">
        <RecipeTileCover asset={asset} />

        {isClip ? (
          <span className="pointer-events-none absolute bottom-3 left-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/65 text-white backdrop-blur-md">
            <Play className="h-4 w-4 fill-current" aria-hidden="true" />
          </span>
        ) : null}

        {/* The unlock action, shown as Explore shows a tile's actions
            (`.showcase-card-actions`): always on a touch screen, under the
            pointer with a mouse. It is the one place the tile names every way
            to pay, so a long price wraps rather than being cut, and `ml-12`
            keeps it clear of the play badge. */}
        <div className="showcase-card-actions pointer-events-none absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/70 via-transparent to-transparent p-3 transition-opacity duration-200">
          <span className="ml-12 inline-flex min-w-0 items-center gap-1.5 rounded-full bg-amber-400 px-3 py-2 text-xs font-bold leading-tight text-[#1a0d08] shadow-md">
            <ShoppingBag className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{unlockLabel}</span>
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-1.5 px-1.5">
        <div className="flex items-start justify-between gap-2">
          <h2 className="line-clamp-1 min-w-0 flex-1 text-sm font-semibold leading-snug text-zinc-100">
            {postTitle}
          </h2>
          {/* When the recipe went up, which is what Recent sorts by: its last
              edit read as the post's date and put the dates out of order. */}
          <time
            dateTime={asset.createdAt}
            className="mt-0.5 whitespace-nowrap text-[10px] font-semibold text-zinc-500"
          >
            {TILE_DATE_FORMATTER.format(new Date(asset.createdAt))}
          </time>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <CreatorIdentity creator={asset.seller} compact linked={false} />
          </div>
          <span className="shrink-0 text-[11px] font-semibold text-zinc-500">{unlockCountLabel}</span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {/* Explore's recipe chip, in its words and its colour. */}
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/10 bg-emerald-500/[0.06] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-400">
            {accessLabel}
          </span>
          {(asset.resourceKinds ?? []).map((kind) => (
            <span
              key={`${asset.id}-${kind}`}
              className="rounded-full border border-white/5 bg-white/[0.02] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400"
            >
              {getPostResourceKindLabel(kind)}
            </span>
          ))}
        </div>
      </div>
    </LinkComponent>
  );
}

// The covers this document has drawn, by address. Drawn again (Back to the listing, the list taking
// over from the shell), they are pictures the browser already has: shown at once, with no
// placeholder and no fade. Bounded, oldest out first.
const drawnCovers = new Set<string>();
const DRAWN_COVERS_LIMIT = 500;

function noteDrawnCover(src: string) {
  drawnCovers.delete(src);
  drawnCovers.add(src);
  if (drawnCovers.size > DRAWN_COVERS_LIMIT) {
    drawnCovers.delete(drawnCovers.values().next().value!);
  }
}

/**
 * `shown`: drawn as it comes, as the server's HTML draws it, and as a picture the browser had at
 * mount is drawn; `waiting`: on its way, with the frame's surface and a shimmer in its place;
 * `arrived`: came after the tile was drawn, and fades in; `failed`: no source loaded.
 */
type CoverState = 'shown' | 'waiting' | 'arrived' | 'failed';

const subscribeToNothing = () => () => undefined;

/** False in the server's render and while React hydrates it; true for whatever mounts after. */
function useIsPastHydration() {
  return useSyncExternalStore(subscribeToNothing, () => true, () => false);
}

/**
 * A picture cover. Only one that is still loading once the tile is on the page waits behind the
 * shimmer and fades in when it lands (200 ms; reduced motion shows it at once). One the browser
 * already has, complete at mount or drawn before in this document, never fades in again; nor does
 * one the server's HTML drew, which shows as it loads, the page's script or not (review of #835:
 * hidden at hydration, a cover half drawn went blank, and the first screen's waited).
 */
function RecipeTileImage({ previewSrc, fallbackSrc, alt }: { previewSrc: string; fallbackSrc: string; alt: string }) {
  const [state, setState] = useState<CoverState>('shown');
  const pastHydration = useIsPastHydration();
  // Read as the tile mounts, never again: the render that follows hydration is not a mount.
  const [mountedAfterHydration] = useState(pastHydration);
  const drawnBefore = drawnCovers.has(previewSrc);
  const imageRef = useCallback((image: HTMLImageElement | null) => {
    if (!image) return;
    // Complete as the page hydrates or the tile mounts: the browser had it (it may have loaded
    // before the page's script ran, with no load event left for React to hear), or it failed.
    if (image.complete) {
      if (image.naturalWidth > 0) noteDrawnCover(previewSrc);
      return;
    }
    if (mountedAfterHydration && !drawnCovers.has(previewSrc)) {
      setState((current) => (current === 'shown' ? 'waiting' : current));
    }
  }, [mountedAfterHydration, previewSrc]);

  return (
    <>
      {state === 'waiting' ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -translate-x-full animate-[skeleton-shimmer_1.5s_linear_infinite] bg-gradient-to-r from-transparent via-white/5 to-transparent motion-reduce:animate-none"
        />
      ) : null}
      <OptimizedPreviewImage
        previewSrc={previewSrc}
        fallbackSrc={fallbackSrc}
        alt={alt}
        sizes={TILE_IMAGE_SIZES}
        // Already in the browser: no wait for the lazy loader to find it on screen.
        loading={drawnBefore ? 'eager' : 'lazy'}
        imageRef={imageRef}
        onLoad={() => {
          noteDrawnCover(previewSrc);
          setState((current) => (current === 'waiting' ? 'arrived' : current));
        }}
        onError={() => setState('failed')}
        className={`object-cover ${
          state === 'waiting'
            ? 'opacity-0'
            : state === 'arrived'
              ? 'opacity-100 transition-opacity duration-200 ease-out motion-reduce:transition-none'
              : ''
        }`}
      />
    </>
  );
}

function RecipeTileCover({ asset }: { asset: MarketplaceResourceListItem }) {
  const post = asset.post;

  if (post?.mediaUrl && post.mediaKind === 'image') {
    return (
      <RecipeTileImage
        // A cover of its own for each picture: what one was waiting for is no other's.
        key={post.mediaPreviewUrl ?? post.mediaUrl}
        previewSrc={post.mediaPreviewUrl ?? post.mediaUrl}
        fallbackSrc={post.mediaUrl}
        alt={post.title}
      />
    );
  }

  if (post?.mediaUrl && post.mediaKind === 'video') {
    // The clip's source is attached only under the pointer, so the shell
    // fetches no clip bytes and draws the poster the list draws.
    return (
      <HoverVideo
        src={resolvePlaybackUrl({ url: post.mediaUrl, renditionUrl: post.mediaRenditionUrl })}
        poster={post.mediaPreviewUrl}
        className="absolute inset-0 h-full w-full object-cover"
      />
    );
  }

  if (post?.postFormat === 'text') {
    // The text cover the profile hub draws in the same 4:5 frame; the tile's
    // chips and stats sit under it.
    return (
      <TextPostPreviewCard
        title={post.title}
        summary={post.body || asset.summary || asset.previewText}
        className="h-full rounded-none border-0 shadow-none"
        showStats={false}
      />
    );
  }

  // A post with no cover left is still a recipe; nothing here should read as a
  // content type.
  return (
    <div className="flex h-full items-center justify-center bg-[var(--ui-surface-inset)] text-zinc-500">
      <ShoppingBag className="h-9 w-9" aria-hidden="true" />
    </div>
  );
}
