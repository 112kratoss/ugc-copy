import type { ComponentType, ReactNode } from 'react';
import { BookText, Play, ShoppingBag } from 'lucide-react';

import {
  getMarketplaceCardAccess,
  type MarketplaceViewerState,
} from '@/app/marketplace/marketplace-card-access';
import { SHOWCASE_FEED_GRID_CLASS } from '@/app/showcase/showcase-layout';
import { OptimizedPreviewImage } from '@/components/OptimizedPreviewImage';
import { formatUnlockCountLabel, getPostResourceKindLabel } from '@/lib/post-resource-bundles';
import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';
import { getUserInitials } from '@/lib/profile';

/**
 * Explore's grid, so a recipe sits in the same place and at the same size as
 * the post it came from: four across on a laptop, one on a phone.
 */
export const MARKETPLACE_RECIPE_GRID_CLASS = `mt-10 ${SHOWCASE_FEED_GRID_CLASS}`;

// The tile's share of the page at each of the grid's widths.
const TILE_IMAGE_SIZES = '(min-width: 1280px) 25vw, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw';

// The first page is drawn on the server, so the date is the same day there and
// in every browser, as Explore's is.
const TILE_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export interface MarketplaceRecipeClip {
  src: string;
  poster: string | null;
  title: string;
}

interface MarketplaceRecipeTileLinkProps {
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
  /** A video post's cover. The default is its poster frame, without the clip's bytes. */
  renderClip?: (clip: MarketplaceRecipeClip) => ReactNode;
}

/**
 * One recipe, drawn as Explore draws a post (`ShowcaseGridCard`): the post's
 * cover in a 4:5 frame, and under it the title and date, the creator, and the
 * recipe's price and kinds. The shell and the interactive list both draw this,
 * so nothing moves when the list takes over. The whole tile is one link to the
 * post's recipe, which is why the creator has no link of their own here.
 */
export function MarketplaceRecipeTile({
  asset,
  viewer,
  href,
  linkComponent: LinkComponent = 'a',
  renderClip = renderPosterFrame,
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
      className="group/recipe ui-focus-ring flex min-w-0 flex-col rounded-[1.5rem]"
    >
      <div className="relative aspect-[4/5] overflow-hidden rounded-[1.5rem] border border-[var(--ui-border-subtle)] bg-black transition duration-200 group-hover/recipe:border-[rgba(255,122,89,0.28)] group-hover/recipe:shadow-[var(--ui-shadow-card-hover)]">
        <RecipeTileCover asset={asset} renderClip={renderClip} />

        {isClip ? (
          <span className="pointer-events-none absolute bottom-3 left-3 inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/65 text-white backdrop-blur-md transition-opacity duration-200 group-hover/recipe:opacity-0">
            <Play className="h-4 w-4 fill-current" aria-hidden="true" />
          </span>
        ) : null}

        {/* What a click does, where a pointer can hover, as Explore shows a
            tile's actions. Without hover the chip under the tile prices it. */}
        <div className="pointer-events-none absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/70 via-transparent to-transparent p-3 opacity-0 transition-opacity duration-200 group-hover/recipe:opacity-100 group-focus-visible/recipe:opacity-100">
          <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-amber-400 px-3 py-2 text-xs font-bold text-[#1a0d08] shadow-md">
            <ShoppingBag className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{unlockLabel}</span>
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-1.5 px-1.5">
        <div className="flex items-start justify-between gap-2">
          <h2 className="line-clamp-1 min-w-0 flex-1 text-sm font-semibold leading-snug text-zinc-100">
            {postTitle}
          </h2>
          <time
            dateTime={asset.updatedAt}
            className="mt-0.5 whitespace-nowrap text-[10px] font-semibold text-zinc-500"
          >
            {TILE_DATE_FORMATTER.format(new Date(asset.updatedAt))}
          </time>
        </div>

        <div className="flex items-center justify-between gap-2">
          <RecipeTileSeller seller={asset.seller} />
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

function RecipeTileCover({
  asset,
  renderClip,
}: {
  asset: MarketplaceResourceListItem;
  renderClip: (clip: MarketplaceRecipeClip) => ReactNode;
}) {
  const post = asset.post;

  if (post?.mediaUrl && post.mediaKind === 'image') {
    return (
      <OptimizedPreviewImage
        previewSrc={post.mediaPreviewUrl ?? post.mediaUrl}
        fallbackSrc={post.mediaUrl}
        alt={post.title}
        sizes={TILE_IMAGE_SIZES}
        className="object-cover"
      />
    );
  }

  if (post?.mediaUrl && post.mediaKind === 'video') {
    return renderClip({
      src: post.mediaRenditionUrl ?? post.mediaUrl,
      poster: post.mediaPreviewUrl,
      title: post.title,
    });
  }

  if (post?.postFormat === 'text') {
    return (
      <div className="flex h-full flex-col bg-[radial-gradient(circle_at_top_left,rgba(56,189,248,0.12),transparent_46%),var(--ui-surface-inset)] p-5">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-400">
          <BookText className="h-3.5 w-3.5" aria-hidden="true" />
          Text
        </span>
        <div className="mt-6 line-clamp-3 text-lg font-semibold leading-snug text-white">{post.title}</div>
        <p className="mt-3 line-clamp-6 whitespace-pre-wrap text-sm leading-6 text-zinc-300">
          {post.body || asset.summary || asset.previewText}
        </p>
      </div>
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

/** The poster alone: the clip's bytes wait for the interactive list. */
function renderPosterFrame({ poster, title }: MarketplaceRecipeClip) {
  return (
    <video
      aria-label={title}
      poster={poster ?? undefined}
      preload="none"
      muted
      playsInline
      className="h-full w-full object-cover"
    />
  );
}

/** `CreatorIdentity`'s compact row, without its link (the tile is the link). */
function RecipeTileSeller({ seller }: { seller: MarketplaceResourceListItem['seller'] }) {
  const showUsername = Boolean(seller.username)
    && seller.username?.trim().toLowerCase() !== seller.name.trim().toLowerCase();

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <span className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 bg-white/5 text-[11px] font-semibold text-zinc-200">
        <span aria-hidden="true">{getUserInitials(seller.name)}</span>
        {seller.avatar ? (
          <OptimizedPreviewImage
            previewSrc={seller.avatar}
            fallbackSrc={seller.avatar}
            fallbackToUnoptimized
            alt={`${seller.name} avatar`}
            sizes="32px"
            className="object-cover"
          />
        ) : null}
      </span>
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-white">{seller.name}</div>
        {showUsername ? <div className="truncate text-xs text-zinc-400">@{seller.username}</div> : null}
      </div>
    </div>
  );
}
