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

interface FeedPostCardProps {
    card: PostFeedCard;
    isSaved: boolean;
    saving: boolean;
    expanded: boolean;
    commentsOpen: boolean;
    accessToken: string | null;
    /**
     * Where detail links say the viewer came from (and return to). Defaults to
     * the /feed page; the embedded home-dashboard feed passes its own.
     */
    detailContext?: FeedDetailContext;
    onToggleExpanded: () => void;
    onToggleComments: () => void;
    onToggleSave: () => void;
    onCommentCountChange: (commentCount: number) => void;
    onOpenMedia: (mediaIndex: number) => void;
}

/**
 * A post as Reddit frames one: a thin attribution line, then the title as the
 * loudest thing on the card, then the body, then media as an attachment. A text
 * post gets a framed body with an accent rail so it reads as something written
 * rather than as a media card whose preview failed to load.
 */
function FeedPostCardView({
    card,
    isSaved,
    saving,
    expanded,
    commentsOpen,
    accessToken,
    detailContext = DEFAULT_DETAIL_CONTEXT,
    onToggleExpanded,
    onToggleComments,
    onToggleSave,
    onCommentCountChange,
    onOpenMedia,
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

    return (
        <article className="overflow-hidden rounded-[1.5rem] border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-1)] transition hover:border-[var(--ui-border-default)]">
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
                <span className="ml-auto shrink-0 rounded-full border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--ui-text-muted)]">
                    {card.categoryLabel}
                </span>
            </div>

            <div className="flex flex-col gap-3 px-4 pt-2 sm:px-5">
                <h2 className="text-lg font-extrabold leading-snug tracking-[-0.01em] text-[var(--ui-text-primary)] sm:text-xl">
                    <Link href={detailHref} prefetch={false} className="ui-focus-ring rounded-sm hover:text-white">
                        {card.title}
                    </Link>
                </h2>

                {card.body ? (
                    <PostBody
                        body={card.body}
                        framed={card.framedBody}
                        clampLines={card.clampLines}
                        canExpand={card.canExpandBody}
                        expanded={expanded}
                        onToggle={onToggleExpanded}
                    />
                ) : null}
            </div>

            {showMedia ? (
                <div className="mt-3 px-4 sm:px-5">
                    <ShowcaseMediaCarousel
                        mediaItems={mediaItems}
                        title={card.title}
                        // One column, so media keeps its real shape instead of being
                        // cropped into the grid's 4:5 tile, and a second slide with a
                        // different shape is contained rather than cut.
                        aspectRatio={coverAspectRatio}
                        fit="contain"
                        sizes="(min-width: 768px) 640px, 100vw"
                        viewportClassName="max-h-[70vh] rounded-2xl border border-[var(--ui-border-subtle)]"
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
                {item.canRemix ? (
                    <Link
                        href={detailHref}
                        prefetch={false}
                        className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full px-3 text-xs font-bold text-[var(--ui-text-muted)] transition hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
                    >
                        <Repeat2 className="h-4 w-4" aria-hidden="true" />
                        {card.remixLabel}
                    </Link>
                ) : null}
                <PublicShareButton
                    generationId={item.id}
                    title={card.title}
                    description={card.body || item.prompt}
                    sourceSurface="feed"
                    accessToken={accessToken}
                    iconOnly
                    className="ui-focus-ring inline-flex h-11 w-11 items-center justify-center rounded-full text-[var(--ui-text-muted)] transition hover:bg-[var(--ui-surface-2)] hover:text-[var(--ui-text-primary)]"
                />
            </div>

            {commentsOpen ? (
                <div className="border-t border-[var(--ui-border-subtle)] px-4 py-4 sm:px-5">
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
    framed,
    clampLines,
    canExpand,
    expanded,
    onToggle,
}: {
    body: string;
    framed: boolean;
    clampLines: number;
    canExpand: boolean;
    expanded: boolean;
    onToggle: () => void;
}) {
    const text = (
        <p
            className={`whitespace-pre-wrap ${
                framed
                    ? 'text-base leading-7 text-[var(--ui-text-secondary)]'
                    : 'text-sm leading-6 text-[var(--ui-text-muted)]'
            }`}
            style={expanded ? undefined : {
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: clampLines,
                overflow: 'hidden',
            }}
        >
            {body}
        </p>
    );

    const readMore = canExpand ? (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="ui-focus-ring inline-flex min-h-11 items-center self-start rounded-full px-2 text-xs font-extrabold text-[var(--ui-primary)] hover:bg-[var(--ui-surface-2)]"
        >
            {expanded ? 'Show less' : 'Read more'}
        </button>
    ) : null;

    if (!framed) {
        return (
            <div className="flex flex-col gap-1">
                {text}
                {readMore}
            </div>
        );
    }

    return (
        <div className="flex gap-0 overflow-hidden rounded-2xl bg-[var(--ui-surface-2)]">
            <span aria-hidden="true" className="w-[3px] shrink-0 bg-[var(--ui-primary)]" />
            <div className="flex flex-1 flex-col gap-2 px-4 py-3.5">
                {text}
                {readMore}
            </div>
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
