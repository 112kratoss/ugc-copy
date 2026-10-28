'use client';

import Link from 'next/link';
import { Suspense, use, useMemo, useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { LayoutTemplate, Play, Repeat2 } from 'lucide-react';
import clsx from 'clsx';

import { HoverVideo } from '@/components/HoverVideo';
import { OptimizedPreviewImage } from '@/components/OptimizedPreviewImage';
import { orderStartPosts, startPostRemix, type CreatorStartPost } from '@/lib/creator-start-posts';
import { homeShelfCreatorLabel } from '@/lib/home-shelf-copy';
import type { RemixTool } from '@/lib/remix-tools';

/**
 * The shelf's posts on the creator pages (owner, 2026-10-28; artboards Main and
 * Generating): "Start from a post" in the empty canvas beside the column, a strip in the
 * column where the canvas sits under it, and "While you wait" under a run at work. Each
 * card's Remix says what its remix costs on this balance, fitted to it as the page will
 * fit it once open (`startPostRemix`). The page is handed the posts unawaited, so each
 * place reads them in a boundary of its own and the creator never waits on them.
 */

/** The posts the page was handed: none for a remix, which opens on its own post. */
export type StartPostsSource = Promise<CreatorStartPost[]> | null | undefined;

function useOrderedPosts(source: Promise<CreatorStartPost[]>, tool: RemixTool) {
  const posts = use(source);
  return useMemo(() => orderStartPosts(posts, tool), [posts, tool]);
}

function postPath(post: CreatorStartPost) {
  return `/showcase/${encodeURIComponent(post.id)}`;
}

/** "Remix · 19", and the words a screen reader hears for it. */
function remixWords(post: CreatorStartPost, balance: number | null) {
  const remix = startPostRemix(post, balance);
  const creator = homeShelfCreatorLabel(post.creator);
  const of = `“${post.title}”${creator ? ` by ${creator}` : ''}`;
  const on = remix.fitted ? ` on ${remix.fitted.modelName}${remix.fitted.sameLength ? '' : `, ${remix.fitted.durationSeconds} seconds`}` : '';
  const price = remix.cost === null ? '' : `, ${remix.cost} ${remix.cost === 1 ? 'credit' : 'credits'}`;
  return {
    remix,
    face: remix.cost === null ? 'Remix' : `Remix · ${remix.cost}`,
    label: `Remix ${of}${on}${price}`,
    /** Where the run moved, said under the creator's name: "On Seedance 2 Mini · runs 5s". */
    fit: remix.fitted
      ? `On ${remix.fitted.modelName}${remix.fitted.sameLength ? '' : ` · runs ${remix.fitted.durationSeconds}s`}`
      : null,
  };
}

/**
 * A post's picture, its clip playing while the pointer is over it or a key is on the
 * post's link: mounted only then, so a row of posts fetches no clip nobody looks at.
 */
function PostThumb({ post, playing, badge, sizes }: { post: CreatorStartPost; playing: boolean; badge?: string | null; sizes: string }) {
  return (
    <span className="relative block aspect-[3/4] overflow-hidden rounded-ui-xl border border-[var(--ui-border-subtle)] bg-[var(--ui-surface-2)]">
      <OptimizedPreviewImage previewSrc={post.posterUrl} alt="" sizes={sizes} className="object-cover" />
      {playing && post.clipUrl ? (
        <HoverVideo key={post.clipUrl} src={post.clipUrl} autoPlay className="absolute inset-0 h-full w-full object-cover" />
      ) : null}
      {badge ? (
        <span className="absolute left-2 top-2 max-w-[calc(100%-1rem)] truncate rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-bold text-white">
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

const REMIX_LINK_CLASS =
  'ui-focus-ring inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-3 text-xs font-extrabold text-[var(--ui-text-primary)] transition-colors duration-150 hover:bg-[var(--ui-surface-3)] active:scale-[0.98]';

/** One post: its picture and title (to the post), its creator, and its Remix with the price. */
function StartPostCard({ post, balance, compact = false, watchOnly = false, className }: {
  post: CreatorStartPost;
  balance: number | null;
  className?: string;
  /** The phone strip's: no model badge, the price alone on the button. */
  compact?: boolean;
  /** "While you wait": a post to watch, with no Remix under it. */
  watchOnly?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const creator = homeShelfCreatorLabel(post.creator);
  const words = remixWords(post, balance);
  return (
    <li
      className={clsx('flex min-w-0 flex-col gap-1.5', className)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <Link
        href={postPath(post)}
        prefetch={false}
        // The post's own words, not its picture's badge too.
        aria-label={creator ? `${post.title}, by ${creator}` : post.title}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        className="ui-focus-ring group flex min-w-0 flex-col gap-1.5 rounded-ui-xl"
      >
        <PostThumb post={post} playing={hovered} badge={compact ? null : post.modelName} sizes={compact ? '132px' : '(min-width: 1440px) 200px, 160px'} />
        <span className="truncate text-sm font-bold text-[var(--ui-text-primary)] group-hover:underline">{post.title}</span>
      </Link>
      {creator ? <span className="-mt-1 truncate text-xs text-[var(--ui-text-muted)]">{creator}</span> : null}
      {!watchOnly && words.fit ? (
        <span data-testid="start-post-fit" className="-mt-1 truncate text-xs text-[var(--ui-text-faint)]">{words.fit}</span>
      ) : null}
      {!watchOnly ? (
        <Link href={post.makeHref} prefetch={false} aria-label={words.label} className={clsx(REMIX_LINK_CLASS, 'mt-auto')}>
          {compact ? null : <Repeat2 aria-hidden className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{words.face}</span>
        </Link>
      ) : null}
    </li>
  );
}

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

function CanvasPostsSection({ posts, balance }: { posts: CreatorStartPost[] | null; balance: number | null }) {
  return (
    <section aria-labelledby="creator-start-posts-title" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h3 id="creator-start-posts-title" className="text-base font-bold text-[var(--ui-text-primary)]">Start from a post</h3>
          <p className="mt-0.5 text-sm text-[var(--ui-text-muted)]">A remix opens with the post’s prompt and settings, fitted to your balance.</p>
        </div>
        <Link href="/showcase" prefetch={false} className="ui-focus-ring rounded-sm text-sm font-semibold text-[var(--ui-text-secondary)] underline underline-offset-4 hover:text-[var(--ui-text-primary)]">
          See all in Explore
        </Link>
      </div>
      {posts ? (
        <ul className={CANVAS_GRID_CLASS}>
          {posts.map((post) => <StartPostCard key={post.id} post={post} balance={balance} />)}
        </ul>
      ) : (
        // Their places, held while the posts are on their way.
        <ul aria-hidden className={CANVAS_GRID_CLASS}>
          {[0, 1, 2, 3].map((slot) => (
            <li key={slot} className="space-y-2">
              <span className="block aspect-[3/4] rounded-ui-xl bg-[var(--ui-surface-2)]" />
              <span className="block h-3 w-3/4 rounded-full bg-[var(--ui-surface-2)]" />
              <span className="block h-11 rounded-full bg-[var(--ui-surface-2)]" />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EmptyCanvasBody({ posts, icon, title, hint, frame, balance }: {
  posts: CreatorStartPost[] | null;
  icon: LucideIcon;
  title: string;
  hint: string;
  frame: ReactNode;
  balance: number | null;
}) {
  if (posts && posts.length === 0) return <>{frame}</>;
  return (
    <>
      {/* Under the column the posts are a strip in it, and the canvas keeps its frame. */}
      <div className="flex flex-1 flex-col min-[1120px]:hidden">{frame}</div>
      <div data-testid="creator-start-posts" className="hidden min-w-0 flex-col gap-6 min-[1120px]:flex">
        <CanvasEmptyLine icon={icon} title={title} hint={hint} />
        <CanvasPostsSection posts={posts} balance={balance} />
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--ui-text-muted)]">
          <LayoutTemplate aria-hidden className="h-4 w-4 shrink-0" />
          Prefer a step-by-step start?
          <Link href="/templates" prefetch={false} className="ui-focus-ring rounded-sm font-semibold text-[var(--ui-text-secondary)] underline underline-offset-4 hover:text-[var(--ui-text-primary)]">
            Browse templates
          </Link>
        </p>
      </div>
    </>
  );
}

function ResolvedEmptyCanvas(props: Omit<Parameters<typeof EmptyCanvasBody>[0], 'posts'> & { source: Promise<CreatorStartPost[]>; tool: RemixTool }) {
  const { source, tool, ...rest } = props;
  const posts = useOrderedPosts(source, tool);
  return <EmptyCanvasBody posts={posts} {...rest} />;
}

/**
 * The empty canvas beside the column: where the result will land, then the posts to
 * start from, each Remix priced on this balance (a visitor's: the welcome credits).
 * Under the column, and where there are no posts, the frame alone (`frame`, drawn in a
 * `CreatorCanvasStage`), as before.
 */
export function CreatorEmptyCanvas({ source, tool, balance, icon, title, hint, frame }: {
  source: StartPostsSource;
  tool: RemixTool;
  balance: number | null;
  icon: LucideIcon;
  title: string;
  hint: string;
  frame: ReactNode;
}) {
  if (!source) return <>{frame}</>;
  const shared = { icon, title, hint, frame, balance };
  return (
    <Suspense fallback={<EmptyCanvasBody posts={null} {...shared} />}>
      <ResolvedEmptyCanvas source={source} tool={tool} {...shared} />
    </Suspense>
  );
}

function ResolvedStrip({ source, tool, balance }: { source: Promise<CreatorStartPost[]>; tool: RemixTool; balance: number | null }) {
  const posts = useOrderedPosts(source, tool);
  if (posts.length === 0) return null;
  return (
    <section aria-labelledby="creator-start-strip-title" className="min-[1120px]:hidden">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id="creator-start-strip-title" className="ui-kicker">Start from a post</h2>
        <Link href="/showcase" prefetch={false} className="ui-focus-ring rounded-sm text-sm font-semibold text-[var(--ui-text-secondary)] underline underline-offset-4 hover:text-[var(--ui-text-primary)]">
          See all
        </Link>
      </div>
      {/* Scrolled sideways by touch; the column keeps its width. */}
      <ul className="app-scrollbar -mx-1 grid snap-x grid-flow-col auto-cols-[8.25rem] gap-3 overflow-x-auto px-1 pb-2">
        {posts.map((post) => <StartPostCard key={post.id} post={post} balance={balance} compact className="snap-start" />)}
      </ul>
    </section>
  );
}

/** The posts as a strip in the column, where the canvas sits under it (under 1120px): the artboard Main at 390. */
export function CreatorStartPostsStrip({ source, tool, balance }: { source: StartPostsSource; tool: RemixTool; balance: number | null }) {
  if (!source) return null;
  return (
    <Suspense fallback={null}>
      <ResolvedStrip source={source} tool={tool} balance={balance} />
    </Suspense>
  );
}

function ResolvedWhileYouWait({ source, tool }: { source: Promise<CreatorStartPost[]>; tool: RemixTool }) {
  const posts = useOrderedPosts(source, tool);
  if (posts.length === 0) return null;
  return (
    <section aria-labelledby="creator-while-you-wait-title" className="space-y-3">
      <h3 id="creator-while-you-wait-title" className="ui-kicker">While you wait</h3>
      <ul className={CANVAS_GRID_CLASS}>
        {posts.map((post) => <StartPostCard key={post.id} post={post} balance={null} watchOnly />)}
      </ul>
    </section>
  );
}

/** Posts to watch under a run at work (the artboard Generating). */
export function CreatorWhileYouWait({ source, tool }: { source: StartPostsSource; tool: RemixTool }) {
  if (!source) return null;
  return (
    <Suspense fallback={null}>
      <ResolvedWhileYouWait source={source} tool={tool} />
    </Suspense>
  );
}
