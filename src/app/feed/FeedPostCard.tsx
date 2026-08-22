'use client';

import { Heart, MessageCircle, Repeat2, ShoppingBag } from 'lucide-react';
import Link from 'next/link';
import { memo } from 'react';

import PostCommentAvatar from '@/app/components/PostCommentAvatar';
import PostComments from '@/app/components/PostComments';
import PublicShareButton from '@/app/components/PublicShareButton';
import ShowcaseMediaCarousel from '@/app/showcase/ShowcaseMediaCarousel';
import { buildShowcaseDetailPath } from '@/lib/share';
import { getAssetAccessLabel } from '@/lib/showcase-asset-labels';
import type { PostFeedCard } from '@/lib/post-feed-presentation';

export interface FeedDetailContext {
    from: string;
    returnTo: string;
}

const DEFAULT_DETAIL_CONTEXT: FeedDetailContext = { from: 'community', returnTo: '/feed' };

/**
 * Everything on the card that owns its own click. The card-level handler below
 * defers to all of it, so adding an interactive element needs no change here
 * unless it is neither a link nor a button — in which case mark it
 * `data-feed-card-inert`.
 */
const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'label',
  'video',
  'audio',
  'summary',
  '[role="dialog"]',
  '[role="menu"]',
  '[contenteditable="true"]',
  '[data-feed-card-inert]',
].join(', ');

interface FeedPostCardProps {
    card: PostFeedCard;
    isSaved: boolean;
    saving: boolean;
    expanded: boolean;
    commentsOpen: boolean;
    accessToken: string | null;
    /** Prioritizes the above-the-fold cover that can become the page LCP. */
    priorityMedia?: boolean;
    /**
     * Where detail links say the viewer came from (and return to). Defaults to
     * the /feed page; the embedded home-dashboard feed passes its own.
     */
    detailContext?: FeedDetailContext;
    onToggleExpanded: () => void;
    onToggleComments: () => void;
    onToggleSave: () => void;
    onShared?: () => void;
    onCommentCountChange: (commentCount: number) => void;
    onOpenMedia: (mediaIndex: number) => void;
    /** Opens the post page. Fired by a click on the card outside any control. */
    onOpenPost: () => void;
    /**
     * Warms the post page on hover or focus, so the click that follows is a
     * cache hit rather than a cold round trip. Safe to call repeatedly.
     */
    onPrefetchPost: () => void;
}

/**
 * A post as Reddit frames one: a thin attribution line, then the title as the
 * loudest thing on the card, then the body, then media as an attachment. A text
 * post is the same card with nothing attached — its body simply clamps, and the
 * card click is what opens the rest.
 */
function FeedPostCardView({
    card,
    isSaved,
    saving,
    expanded,
    commentsOpen,
    accessToken,
    priorityMedia = false,
    detailContext = DEFAULT_DETAIL_CONTEXT,
    onToggleExpanded,
    onToggleComments,
    onToggleSave,
    onShared,
    onCommentCountChange,
    onOpenMedia,
    onOpenPost,
    onPrefetchPost,
}: FeedPostCardProps) {
    const { item } = card;
    const mediaItems = (item.mediaItems ?? []).slice().sort((left, right) => left.sortOrder - right.sortOrder);
    const showMedia = card.kind !== 'text' && mediaItems.length > 0;
    const cover = mediaItems[0];
    // The frame takes the cover's true shape — no cropping — and a max-height on
    // the viewport is what stops a very tall portrait from eating the screen.
    // Without server dimensions the carousel measures the cover on load.
    const coverAspectRatio = cover?.width && cover?.height
        ? cover.width / cover.height
        : 'auto';
    const detailHref = buildShowcaseDetailPath(item.id, detailContext);

    // Reddit's rule: the media expands in place, and everywhere else on the card
    // opens the post. The title stays a real <Link> — it is the one focusable
    // permalink, so keyboard and screen-reader users get exactly one link, and
    // hover/right-click still show the URL. This handler is pointer convenience
    // layered on top of it, with no role and no tab stop of its own.
    const isOwnClick = (target: EventTarget | null) =>
        !(target instanceof HTMLElement) || !target.closest(INTERACTIVE_SELECTOR);

    const openInNewTab = () => window.open(detailHref, '_blank', 'noopener,noreferrer');

    return (
        <article
            className="cursor-pointer overflow-hidden rounded-[1.5rem] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] transition hover:border-[var(--ui-border-default)] [content-visibility:auto] [contain-intrinsic-size:auto_640px]"
            // Pointing at a card is the earliest honest signal that it is about
            // to be opened. Warming here is why the click feels instant; the
            // post links stay `prefetch={false}` so nothing is fetched for
            // cards the viewer merely scrolled past.
            onPointerEnter={onPrefetchPost}
            onFocus={onPrefetchPost}
            onClick={(event) => {
                if (event.defaultPrevented) return;
                // A double or triple click is selecting text, not navigating.
                if (event.detail >= 2) return;
                if (!isOwnClick(event.target)) return;
                // A click that ends a drag-select lands here too; navigating
                // would throw away the selection the reader just made.
                const selection = window.getSelection();
                if (selection && !selection.isCollapsed) return;
                if (event.metaKey || event.ctrlKey) {
                    openInNewTab();
                    return;
                }
                // Shift (new window) and Alt (download) are the browser's.
                if (event.shiftKey || event.altKey) return;
                onOpenPost();
            }}
            onAuxClick={(event) => {
                if (event.button !== 1) return;
                if (!isOwnClick(event.target)) return;
                event.preventDefault(); // suppress middle-click autoscroll
                openInNewTab();
            }}
        >
            <div className="flex items-center gap-2 px-4 pt-4 sm:px-5">
                {item.creator.username ? (
                    <Link
                        href={`/creators/${item.creator.username}`}
                        prefetch={false}
                        className="ui-focus-ring flex min-w-0 items-center gap-2 rounded-full"
                    >
                        <PostCommentAvatar avatarUrl={item.creator.avatar} name={item.creator.name} size={24} />
                        <span className="truncate text-xs font-bold text-[var(--ui-text-secondary)]">
                            {card.creatorLabel}
                        </span>
                    </Link>
                ) : (
                    <div className="flex min-w-0 items-center gap-2">
                        <PostCommentAvatar avatarUrl={item.creator.avatar} name={item.creator.name} size={24} />
                        <span className="truncate text-xs font-bold text-[var(--ui-text-secondary)]">
                            {card.creatorLabel}
                        </span>
                    </div>
                )}
                <span className="text-xs text-[var(--ui-text-faint)]">{`· ${card.timeLabel}`}</span>
                {card.kind === 'text' ? (
                    <span className="ml-auto shrink-0 rounded-full border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--ui-text-muted)]">
                        {card.categoryLabel}
                    </span>
                ) : null}
            </div>

            <div className="flex flex-col gap-2 px-4 pt-2 sm:px-5">
                <h2 className="text-lg font-extrabold leading-snug tracking-[-0.01em] text-[var(--ui-text-primary)] sm:text-xl">
                    <Link href={detailHref} prefetch={false} className="ui-focus-ring rounded-sm hover:text-white">
                        {card.title}
                    </Link>
                </h2>

                {card.metadataLabel ? (
                    <p className="text-xs font-bold tracking-wide text-[var(--ui-text-faint)]">
                        {card.metadataLabel}
                    </p>
                ) : null}

                {card.body ? (
                    <PostBody
                        body={card.body}
                        clampLines={card.clampLines}
                        canExpand={card.canExpandBody}
                        expanded={expanded}
                        onToggle={onToggleExpanded}
                    />
                ) : null}
            </div>

            {showMedia ? (
                // Inert to the card handler: the carousel's viewport has its own
                // click handler on a bare <div>, which `closest('button')` would
                // not match — without this a media click could both open the
                // lightbox and navigate to the post.
                <div data-feed-card-inert className="mt-3 px-4 sm:px-5">
                    <ShowcaseMediaCarousel
                        mediaItems={mediaItems}
                        title={card.title}
                        // One column, so media keeps its real shape instead of being
                        // cropped into the grid's 4:5 tile, and a second slide with a
                        // different shape is contained rather than cut.
                        aspectRatio={coverAspectRatio}
                        fit="contain"
                        sizes="(min-width: 768px) 640px, 100vw"
                        priority={priorityMedia}
                        // `w-full` is load-bearing: with `width: auto`, CSS
                        // aspect-ratio transfers the max-height back into width,
                        // shrinking the frame to a left-aligned column. Full width
                        // turns the frame into a bounded stage — landscape media
                        // fills it edge to edge, tall portraits sit centered — and
                        // the tighter cap keeps the next post within reach.
                        viewportClassName="w-full max-h-[min(60vh,35rem)] rounded-2xl border border-[var(--ui-border-subtle)]"
                        onOpen={onOpenMedia}
                    />
                </div>
            ) : null}

            {item.asset ? (
                <Link
                    href={buildShowcaseDetailPath(item.id, { ...detailContext, section: 'resources' })}
                    prefetch={false}
                    className="ui-focus-ring mx-4 mt-3 flex min-h-11 items-center gap-2 rounded-2xl border border-amber-300/20 bg-amber-400/[0.08] px-3 text-xs font-bold text-amber-100 transition hover:border-amber-300/35 sm:mx-5"
                >
                    <ShoppingBag className="h-4 w-4" aria-hidden="true" />
                    {getAssetAccessLabel(item.asset)}
                    <span className="truncate font-medium text-amber-100/70">{item.asset.title}</span>
                </Link>
            ) : null}

            <div className="mt-2 flex flex-wrap items-center gap-1 px-2 pb-2 sm:px-3">
                {item.canRemix ? (
                    // The product's differentiated verb leads the row as a labeled
                    // pill; save/comment/share are universal socials and follow.
                    <Link
                        href={detailHref}
                        prefetch={false}
                        className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--ui-primary-strong)]/40 bg-[var(--ui-primary)]/10 px-4 text-xs font-extrabold text-[var(--ui-primary)] transition hover:bg-[var(--ui-primary)]/20"
                    >
                        <Repeat2 className="h-4 w-4" aria-hidden="true" />
                        {card.remixLabel}
                    </Link>
                ) : null}
                <ActionButton
                    label={card.saveLabel}
                    ariaLabel={`${isSaved ? 'Remove save from' : 'Save'} ${card.title}`}
                    pressed={isSaved}
                    disabled={saving}
                    onClick={onToggleSave}
                    icon={<Heart className={`h-4 w-4 ${isSaved ? 'fill-current text-[var(--ui-primary)]' : ''}`} />}
                />
                <ActionButton
                    label={card.commentLabel}
                    ariaLabel={`${commentsOpen ? 'Hide' : 'Show'} comments on ${card.title}`}
                    pressed={commentsOpen}
                    onClick={onToggleComments}
                    icon={<MessageCircle className="h-4 w-4" />}
                />
                <PublicShareButton
                    generationId={item.id}
                    title={card.title}
                    description={card.body || item.prompt}
                    sourceSurface="feed"
                    accessToken={accessToken}
                    onShared={onShared}
                    iconOnly
                    className="ui-focus-ring inline-flex h-11 w-11 items-center justify-center rounded-full text-[var(--ui-text-muted)] transition hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
                />
            </div>

            {commentsOpen ? (
                // Composer and reply threads are for reading and typing in, not
                // a click target for the post.
                <div data-feed-card-inert className="border-t border-[var(--ui-border-subtle)] px-4 py-4 sm:px-5">
                    <PostComments
                        postId={item.id}
                        postCreatorId={item.creator.id}
                        commentCount={item.commentCount}
                        onCommentCountChange={onCommentCountChange}
                    />
                </div>
            ) : null}
        </article>
    );
}

function PostBody({
    body,
    clampLines,
    canExpand,
    expanded,
    onToggle,
}: {
    body: string;
    clampLines: number;
    canExpand: boolean;
    expanded: boolean;
    onToggle: () => void;
}) {
    return (
        <div className="flex flex-col gap-1">
            <p
                // `cursor-auto` restores the I-beam the card's pointer cursor would
                // otherwise hide, so the body still reads as selectable text.
                className="cursor-auto whitespace-pre-wrap text-sm leading-6 text-[var(--ui-text-muted)]"
                // `canExpand` is part of the condition, not just `expanded`: a
                // restored scroll snapshot can carry an expanded id for a card
                // that no longer offers the toggle, which would otherwise leave
                // an unclamped body with no way to collapse it.
                style={expanded && canExpand ? undefined : {
                    display: '-webkit-box',
                    WebkitBoxOrient: 'vertical',
                    WebkitLineClamp: clampLines,
                    overflow: 'hidden',
                }}
            >
                {body}
            </p>
            {canExpand ? (
                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={expanded}
                    className="ui-focus-ring inline-flex min-h-11 items-center self-start rounded-full px-2 text-xs font-extrabold text-[var(--ui-primary)] hover:bg-[var(--ui-surface-2)]"
                >
                    {expanded ? 'Show less' : 'Read more'}
                </button>
            ) : null}
        </div>
    );
}

function ActionButton({
    label,
    ariaLabel,
    icon,
    pressed,
    disabled,
    onClick,
}: {
    label: string;
    ariaLabel: string;
    icon: React.ReactNode;
    pressed?: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-label={ariaLabel}
            aria-pressed={pressed}
            className={`ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-xs font-bold transition disabled:opacity-60 ${
                pressed
                    ? 'bg-[var(--ui-surface-3)] text-[var(--ui-text-primary)]'
                    : 'text-[var(--ui-text-muted)] hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]'
            }`}
        >
            {icon}
            {label}
        </button>
    );
}

export default memo(FeedPostCardView);
