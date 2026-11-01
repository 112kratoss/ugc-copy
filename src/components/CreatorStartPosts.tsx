'use client';

import Link from 'next/link';
import { Component, memo, Suspense, use, useMemo, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { LayoutTemplate, Play, Repeat2 } from 'lucide-react';
import clsx from 'clsx';

import { CREATOR_NOTE_LINK_CLASS, creditsWords, SIDEWAYS_TRACK_CLASS } from '@/components/CreatorColumn';
import { HoverVideo } from '@/components/HoverVideo';
import { OptimizedPreviewImage } from '@/components/OptimizedPreviewImage';
import { useMediaLoadingPreferences } from '@/components/useMediaLoadingPreferences';
import { orderStartPosts, startPostRemixCost, type CreatorStartPost } from '@/lib/creator-start-posts';
import { homeShelfCreatorLabel } from '@/lib/home-shelf-copy';
import type { RemixTool } from '@/lib/remix-tools';
import { buildShowcaseDetailPath } from '@/lib/share';

/**
 * The shelf's posts on the creator pages (owner, 2026-10-28; artboards Main and
 * Generating): "Start from a post" in the empty canvas beside the column, a strip in the
 * column where the canvas sits under it, and "While you wait" under a run at work. Each
 * card's Remix says what its remix costs: the run on the post's own model and settings,
 * where the page opens it whatever the balance (`startPostRemixCost`). The page is handed
 * the posts unawaited, so each place reads them in a boundary of its own
 * (`WithStartPosts`) and the creator never waits on them.
 */

/** The posts the page was handed: none for a remix, which opens on its own post. */
export type StartPostsSource = Promise<CreatorStartPost[]> | null | undefined;

/**
 * The posts come in the page's stream, and a stream cut off on the way rejects them:
 * thrown to the nearest error boundary, which nothing under the root layout is, the whole
 * creator gave way to Next's error page. Caught here, the place draws what it draws
 * without posts.
 */
class StartPostsErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Caught here, it never reaches Next's own reportError, which is what Sentry hears.
    window.reportError?.(error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function OrderedPosts({ source, tool, children }: {
  source: Promise<CreatorStartPost[]>;
  tool: RemixTool;
  children: (posts: CreatorStartPost[]) => ReactNode;
}) {
  const posts = use(source);
  const ordered = useMemo(() => orderStartPosts(posts, tool), [posts, tool]);
  return <>{children(ordered)}</>;
}

/** One place's read of the posts: `loading` while they are on their way, `failed` where they never came. */
function WithStartPosts({ source, tool, loading, failed, children }: {
  source: Promise<CreatorStartPost[]>;
  tool: RemixTool;
  loading: ReactNode;
  failed: ReactNode;
  children: (posts: CreatorStartPost[]) => ReactNode;
}) {
  return (
    <StartPostsErrorBoundary fallback={failed}>
      <Suspense fallback={loading}>
        <OrderedPosts source={source} tool={tool}>{children}</OrderedPosts>
      </Suspense>
    </StartPostsErrorBoundary>
  );
}

/** "Remix · 140", and the words a screen reader hears for it. */
function remixWords(post: CreatorStartPost) {
  const cost = startPostRemixCost(post);
  const creator = homeShelfCreatorLabel(post.creator);
  const of = `“${post.title}”${creator ? ` by ${creator}` : ''}`;
  return {
    face: cost === null ? 'Remix' : `Remix · ${cost}`,
    label: `Remix ${of}${cost === null ? '' : `, ${creditsWords(cost)}`}`,
  };
}

/**
 * A post's picture, its clip playing while the pointer is over it or a key is on the
 * post's link: mounted only then, so a row of posts fetches no clip nobody looks at, and
 * never where the viewer asked for less motion or data, as on Home's shelf.
 */
function PostThumb({ post, playing, badge, sizes }: { post: CreatorStartPost; playing: boolean; badge?: string | null; sizes: string }) {
  return (
    <span className="relative block aspect-[3/4] overflow-hidden rounded-ui-xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)]">
      <OptimizedPreviewImage previewSrc={post.posterUrl} alt="" sizes={sizes} className="object-cover" />
      {playing && post.clipUrl ? (
        <HoverVideo key={post.clipUrl} src={post.clipUrl} autoPlay className="absolute inset-0 h-full w-full object-cover" />
      ) : null}
      {badge ? (
        <span className="absolute left-2 top-2 max-w-[calc(100%-1rem)] truncate rounded-full bg-black/55 px-2 py-0.5 text-xs font-bold text-white">
          {badge}
        </span>
      ) : null}
      {post.clipUrl && !playing ? (
        <span aria-hidden className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-white">
            <Play className="h-4 w-4" />
          </span>
        </span>
      ) : null}
    </span>
  );
}

/** One post: its picture and title (to the post), its creator, and its Remix with the price. */
const StartPostCard = memo(function StartPostCard({ post, compact = false, watchOnly = false, className }: {
  post: CreatorStartPost;
  className?: string;
  /** The phone strip's: no model badge, the price alone on the button. */
  compact?: boolean;
  /** "While you wait": a post to watch, with no Remix under it. */
  watchOnly?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const { prefersReducedMotion, saveData } = useMediaLoadingPreferences();
  const creator = homeShelfCreatorLabel(post.creator);
  const words = watchOnly ? null : remixWords(post);
  return (
    <li
      className={clsx('flex min-w-0 flex-col gap-1.5', className)}
      // A finger on the card is a tap on its way to a link, not a look: no clip for it.
      onPointerEnter={(event) => {
        if (event.pointerType !== 'touch') setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
    >
      <Link
        href={buildShowcaseDetailPath(post.id)}
        prefetch={false}
        // The post's own words, not its picture's badge too.
        aria-label={creator ? `${post.title}, by ${creator}` : post.title}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        className="ui-focus-ring group flex min-w-0 flex-col gap-1.5 rounded-ui-xl"
      >
        <PostThumb
          post={post}
          playing={hovered && !prefersReducedMotion && !saveData}
          badge={compact ? null : post.modelName}
          sizes={compact ? '132px' : '(min-width: 1440px) 200px, 160px'}
        />
        <span className="truncate text-sm font-bold text-[var(--ui-text-primary)] group-hover:underline">{post.title}</span>
      </Link>
      {creator ? <span className="-mt-1 truncate text-xs text-[var(--ui-text-muted)]">{creator}</span> : null}
      {words ? (
        <Link href={post.makeHref} prefetch={false} aria-label={words.label} className="ui-button ui-button-secondary ui-focus-ring mt-auto w-full">
          {compact ? null : <Repeat2 aria-hidden className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{words.face}</span>
        </Link>
      ) : null}
    </li>
  );
});

const CANVAS_GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-x-3 gap-y-5';

/** The empty canvas's line at the top: where the result will land, and how to start. */
function CanvasEmptyLine({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint: string }) {
  return (
    <div className="flex items-center gap-3 rounded-ui-xl border border-dashed border-[var(--ui-border-default)] px-4 py-3">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)]">
        <Icon aria-hidden className="h-4 w-4 text-[var(--ui-text-muted)]" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-[var(--ui-text-primary)]">{title}</span>
        <span className="block text-xs leading-5 text-[var(--ui-text-muted)]">{hint}</span>
      </span>
    </div>
  );
}

/** Cards' places, held while the posts are on their way. */
function CardPlaces({ count, className, slotClassName }: { count: number; className: string; slotClassName?: string }) {
  return (
    <ul aria-hidden className={className}>
      {Array.from({ length: count }, (_, slot) => (
        <li key={slot} className={clsx('space-y-2', slotClassName)}>
          <span className="block aspect-[3/4] rounded-ui-xl bg-[var(--ui-surface-2)]" />
          <span className="block h-3 w-3/4 rounded-full bg-[var(--ui-surface-2)]" />
          <span className="block h-12 rounded-full bg-[var(--ui-surface-2)]" />
        </li>
      ))}
    </ul>
  );
}

function CanvasPostsSection({ posts }: { posts: CreatorStartPost[] | null }) {
  return (
    <section aria-labelledby="creator-start-posts-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 id="creator-start-posts-title" className="text-base font-bold text-[var(--ui-text-primary)]">Start from a post</h3>
          <p className="mt-0.5 text-sm text-[var(--ui-text-muted)]">A remix opens on the post’s model, with its prompt and settings.</p>
        </div>
        <Link href="/showcase" prefetch={false} className={clsx(CREATOR_NOTE_LINK_CLASS, 'text-sm')}>
          See all in Explore
        </Link>
      </div>
      {posts ? (
        <ul className={CANVAS_GRID_CLASS}>
          {posts.map((post) => <StartPostCard key={post.id} post={post} />)}
        </ul>
      ) : (
        <CardPlaces count={4} className={CANVAS_GRID_CLASS} />
      )}
    </section>
  );
}

function EmptyCanvasBody({ posts, icon, title, hint, frame }: {
  posts: CreatorStartPost[] | null;
  icon: LucideIcon;
  title: string;
  hint: string;
  frame: ReactNode;
}) {
  if (posts && posts.length === 0) return <>{frame}</>;
  return (
    <>
      {/* Under the column the posts are a strip in it, and the canvas keeps its frame. */}
      <div className="flex flex-1 flex-col min-[1120px]:hidden">{frame}</div>
      <div data-testid="creator-start-posts" className="hidden min-w-0 flex-col gap-6 min-[1120px]:flex">
        <CanvasEmptyLine icon={icon} title={title} hint={hint} />
        <CanvasPostsSection posts={posts} />
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--ui-text-muted)]">
          <LayoutTemplate aria-hidden className="h-4 w-4 shrink-0" />
          Prefer a step-by-step start?
          <Link href="/templates" prefetch={false} className={CREATOR_NOTE_LINK_CLASS}>
            Browse templates
          </Link>
        </p>
      </div>
    </>
  );
}

/**
 * The empty canvas beside the column: where the result will land, then the posts to
 * start from, each Remix priced as the run it opens. Under the column, and where there
 * are no posts, the frame alone (`frame`, drawn in a `CreatorCanvasStage`), as before.
 */
export function CreatorEmptyCanvas({ source, tool, icon, title, hint, frame }: {
  source: StartPostsSource;
  tool: RemixTool;
  icon: LucideIcon;
  title: string;
  hint: string;
  frame: ReactNode;
}) {
  if (!source) return <>{frame}</>;
  const shared = { icon, title, hint, frame };
  return (
    <WithStartPosts
      source={source}
      tool={tool}
      loading={<EmptyCanvasBody posts={null} {...shared} />}
      failed={frame}
    >
      {(posts) => <EmptyCanvasBody posts={posts} {...shared} />}
    </WithStartPosts>
  );
}

const STRIP_TRACK_CLASS = clsx(SIDEWAYS_TRACK_CLASS, 'auto-cols-[8.25rem] gap-3');

function StripSection({ children }: { children: ReactNode }) {
  return (
    <section aria-labelledby="creator-start-strip-title" className="min-[1120px]:hidden">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id="creator-start-strip-title" className="ui-kicker">Start from a post</h2>
        <Link href="/showcase" prefetch={false} className={clsx(CREATOR_NOTE_LINK_CLASS, 'text-sm')}>
          See all
        </Link>
      </div>
      {children}
    </section>
  );
}

/**
 * The posts as a strip in the column, where the canvas sits under it (under 1120px): the
 * artboard Main at 390. Their places are held while they come, so the prompt under them
 * does not move down when they arrive.
 */
export function CreatorStartPostsStrip({ source, tool }: { source: StartPostsSource; tool: RemixTool }) {
  if (!source) return null;
  return (
    <WithStartPosts
      source={source}
      tool={tool}
      loading={<StripSection><CardPlaces count={3} className={clsx(STRIP_TRACK_CLASS, 'overflow-hidden')} /></StripSection>}
      failed={null}
    >
      {(posts) => (posts.length === 0 ? null : (
        <StripSection>
          {/* Scrolled sideways by touch; the column keeps its width. */}
          <ul className={STRIP_TRACK_CLASS}>
            {posts.map((post) => <StartPostCard key={post.id} post={post} compact className="snap-start" />)}
          </ul>
        </StripSection>
      ))}
    </WithStartPosts>
  );
}

/** Posts to watch under a run at work (the artboard Generating). */
export function CreatorWhileYouWait({ source, tool }: { source: StartPostsSource; tool: RemixTool }) {
  if (!source) return null;
  return (
    <WithStartPosts source={source} tool={tool} loading={null} failed={null}>
      {(posts) => (posts.length === 0 ? null : (
        <section aria-labelledby="creator-while-you-wait-title" className="space-y-3">
          <h3 id="creator-while-you-wait-title" className="ui-kicker">While you wait</h3>
          <ul className={CANVAS_GRID_CLASS}>
            {posts.map((post) => <StartPostCard key={post.id} post={post} watchOnly />)}
          </ul>
        </section>
      ))}
    </WithStartPosts>
  );
}
