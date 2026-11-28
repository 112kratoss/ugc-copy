import type { OwnerCreationKindTotals, OwnerPostVisibilityTotals, OwnerProfileStats } from '@/lib/profile';
import { buildShowcaseDetailPath } from '@/lib/share';

type CreationWorkspaceState =
  | 'unpublished'
  | 'published_no_bundle'
  | 'published_free_bundle'
  | 'published_paid_bundle'
  | 'published_bundle_draft'
  | 'archived_generation';

export type CreationWorkspacePublishBadge =
  | 'Not published'
  | 'Public'
  | 'Unlisted'
  | 'Private'
  | 'Archived';

export type CreationWorkspaceMonetizationKind = 'none' | 'free' | 'paid' | 'draft';

type CreationWorkspacePrimaryAction =
  | 'none'
  | 'publish'
  | 'add-paywall'
  | 'manage-paywall';

type CreationWorkspaceSecondaryAction = 'none' | 'set-paywall' | 'open-post';

export interface CreationWorkspaceGeneration {
  id: string;
  archived_at?: string | null;
  linked_post_id?: string | null;
  linked_post_title?: string | null;
  linked_post_visibility?: 'public' | 'unlisted' | 'private' | null;
  linked_post_archived_at?: string | null;
  /**
   * The linked post's recipe as the creations list sends it. Studio loads only
   * the newest page of posts, so for an older post this is the only copy, and
   * without it a post that sells a recipe read "No recipe" / "Add recipe".
   */
  linked_post_bundle?: CreationWorkspacePost['bundle'];
  /**
   * The linked post's lifetime views, sent for the same reason as the recipe
   * above: Studio holds only the newest page of posts, so for an older post
   * this is the only copy of the count. Null where no count may be shown.
   */
  linked_post_view_count?: number | null;
}

export interface CreationWorkspacePost {
  id: string;
  generationId: string | null;
  visibility: 'public' | 'unlisted' | 'private';
  archivedAt: string | null;
  title: string;
  publicPath: string | null;
  ownerPath: string;
  canShare: boolean;
  /** Lifetime views, left out by a read that carries none. */
  viewCount?: number | null;
  bundle: {
    accessMode: 'free' | 'paid';
    status: 'draft' | 'published';
    priceUsdCents: number;
  } | null;
}

interface CreationWorkspaceResolvedPost {
  id: string;
  title: string;
  visibility: 'public' | 'unlisted' | 'private';
  archivedAt: string | null;
  publicPath: string | null;
  ownerPath: string;
  canShare: boolean;
  bundle: CreationWorkspacePost['bundle'];
  /**
   * Lifetime views, null where none may be drawn. Studio hands it to the
   * shared rule in `ugc-mobile/lib/view-count/`, which draws nothing for 0 or
   * for a post that is not public, so the visibility above decides the rest.
   */
  viewCount: number | null;
}

interface CreationWorkspaceActionLink {
  type: CreationWorkspacePrimaryAction | CreationWorkspaceSecondaryAction;
  label: string | null;
  href: string | null;
}

export interface CreationWorkspaceCardState {
  state: CreationWorkspaceState;
  linkedPost: CreationWorkspaceResolvedPost | null;
  publishBadge: CreationWorkspacePublishBadge;
  monetizationKind: CreationWorkspaceMonetizationKind;
  monetizationLabel: string;
  monetizationPriceUsdCents: number | null;
  primaryAction: CreationWorkspaceActionLink;
  secondaryAction: CreationWorkspaceActionLink;
}

function canShareLinkedPost(
  visibility: 'public' | 'unlisted' | 'private',
  archivedAt: string | null
): boolean {
  return archivedAt === null && (visibility === 'public' || visibility === 'unlisted');
}

function buildCreationsQuery(params: Record<string, string>): string {
  const searchParams = new URLSearchParams(params);
  return searchParams.toString();
}

/**
 * The full composer for a creation, where Publish takes it, as the app's does:
 * it reads the creation from its address and starts from the creation's title.
 * `from` and `returnTo` say where its Back goes; `shareAfterPublish` has it
 * share the post once the post is public.
 */
export function buildCreationComposerPath(
  generationId: string,
  {
    from = 'creations',
    returnTo,
    shareAfterPublish = false,
  }: { from?: string; returnTo?: string; shareAfterPublish?: boolean } = {},
): string {
  return `/post/new?${buildCreationsQuery({
    generationId,
    from,
    ...(returnTo ? { returnTo } : {}),
    ...(shareAfterPublish ? { shareAfterPublish: '1' } : {}),
  })}`;
}

function buildGeneratedPaywallComposerPath(generationId: string): string {
  return `/post/new?${buildCreationsQuery({
    generationId,
    publishIntent: 'paid-generation',
    resourceMode: 'paid',
    focus: 'price',
    from: 'creations',
  })}`;
}

/**
 * Every recipe edit on an existing post goes through the post editor, which
 * loads the stored bundle rather than rebuilding one from the generation
 * prefill: that would replace a hand-built recipe with the automatic one.
 *
 * "Add recipe" (a post without one) opens the editor at its recipe with no
 * mode chosen and no field focused, headed "Add a recipe to this post": it
 * used to choose Paid and put the cursor in the price before there was
 * anything to sell (A-F17). "Manage recipe" opens at the recipe's own mode
 * with its price focused.
 */
export function buildPostRecipeManagementPath(post: {
  id: string;
  bundle: { accessMode: 'free' | 'paid' } | null;
}): string {
  if (!post.bundle) {
    return `/post/${post.id}/edit?${buildCreationsQuery({
      recipe: 'add',
      from: 'creations',
    })}#recipe`;
  }
  return `/post/${post.id}/edit?${buildCreationsQuery({
    resourceMode: post.bundle.accessMode,
    focus: 'price',
    from: 'creations',
  })}#recipe`;
}

function buildCreationOpenPostPath(post: CreationWorkspaceResolvedPost): string {
  if (post.archivedAt || post.visibility === 'private') {
    return post.ownerPath;
  }

  return buildShowcaseDetailPath(post.id, {
    from: 'studio',
    returnTo: '/creations',
  });
}

function resolveLinkedPost(
  generation: CreationWorkspaceGeneration,
  posts: CreationWorkspacePost[]
): CreationWorkspaceResolvedPost | null {
  const matchedPost =
    posts.find((post) => post.generationId === generation.id) ??
    (generation.linked_post_id ? posts.find((post) => post.id === generation.linked_post_id) : null) ??
    null;

  if (matchedPost) {
    return {
      id: matchedPost.id,
      title: matchedPost.title,
      visibility: matchedPost.visibility,
      archivedAt: matchedPost.archivedAt,
      publicPath: matchedPost.publicPath,
      ownerPath: matchedPost.ownerPath,
      canShare: matchedPost.canShare,
      bundle: matchedPost.bundle,
      // The loaded post is the fresher of the two: its count was read with the
      // posts list, the generation's with the creations list.
      viewCount: matchedPost.viewCount ?? generation.linked_post_view_count ?? null,
    };
  }

  if (!generation.linked_post_id) {
    return null;
  }

  const visibility = generation.linked_post_visibility ?? 'public';
  const archivedAt = generation.linked_post_archived_at ?? null;

  return {
    id: generation.linked_post_id,
    title: generation.linked_post_title?.trim() || 'Linked post',
    visibility,
    archivedAt,
    publicPath: canShareLinkedPost(visibility, archivedAt) ? `/showcase/${generation.linked_post_id}` : null,
    ownerPath: `/post/${generation.linked_post_id}/edit`,
    canShare: canShareLinkedPost(visibility, archivedAt),
    bundle: generation.linked_post_bundle ?? null,
    viewCount: generation.linked_post_view_count ?? null,
  };
}

function getPublishBadge(linkedPost: CreationWorkspaceResolvedPost | null): CreationWorkspacePublishBadge {
  if (!linkedPost) {
    return 'Not published';
  }

  if (linkedPost.archivedAt) {
    return 'Archived';
  }

  if (linkedPost.visibility === 'unlisted') {
    return 'Unlisted';
  }

  if (linkedPost.visibility === 'private') {
    return 'Private';
  }

  return 'Public';
}

function getMonetizationState(linkedPost: CreationWorkspaceResolvedPost | null): {
  kind: CreationWorkspaceMonetizationKind;
  label: string;
  priceUsdCents: number | null;
} {
  if (!linkedPost?.bundle) {
    return {
      kind: 'none',
      label: 'No recipe',
      priceUsdCents: null,
    };
  }

  if (linkedPost.bundle.status === 'draft') {
    return {
      kind: 'draft',
      label: 'Recipe draft',
      priceUsdCents: linkedPost.bundle.priceUsdCents,
    };
  }

  if (linkedPost.bundle.accessMode === 'free') {
    return {
      kind: 'free',
      label: 'Free recipe',
      priceUsdCents: 0,
    };
  }

  return {
    kind: 'paid',
    label: 'Paid recipe',
    priceUsdCents: linkedPost.bundle.priceUsdCents,
  };
}

export function resolveCreationWorkspaceCardState(
  generation: CreationWorkspaceGeneration,
  posts: CreationWorkspacePost[]
): CreationWorkspaceCardState {
  if (generation.archived_at) {
    return {
      state: 'archived_generation',
      linkedPost: null,
      publishBadge: 'Archived',
      monetizationKind: 'none',
      monetizationLabel: 'No recipe',
      monetizationPriceUsdCents: null,
      primaryAction: {
        type: 'none',
        label: null,
        href: null,
      },
      secondaryAction: {
        type: 'none',
        label: null,
        href: null,
      },
    };
  }

  const linkedPost = resolveLinkedPost(generation, posts);

  if (!linkedPost) {
    return {
      state: 'unpublished',
      linkedPost: null,
      publishBadge: 'Not published',
      monetizationKind: 'none',
      monetizationLabel: 'No recipe',
      monetizationPriceUsdCents: null,
      primaryAction: {
        type: 'publish',
        label: 'Publish',
        href: buildCreationComposerPath(generation.id),
      },
      secondaryAction: {
        type: 'set-paywall',
        label: 'Add paid recipe',
        href: buildGeneratedPaywallComposerPath(generation.id),
      },
    };
  }

  const monetization = getMonetizationState(linkedPost);
  const state: CreationWorkspaceState =
    !linkedPost.bundle
      ? 'published_no_bundle'
      : linkedPost.bundle.status === 'draft'
        ? 'published_bundle_draft'
        : linkedPost.bundle.accessMode === 'free'
          ? 'published_free_bundle'
          : 'published_paid_bundle';

  return {
    state,
    linkedPost,
    publishBadge: getPublishBadge(linkedPost),
    monetizationKind: monetization.kind,
    monetizationLabel: monetization.label,
    monetizationPriceUsdCents: monetization.priceUsdCents,
    primaryAction: {
      type: state === 'published_no_bundle' ? 'add-paywall' : 'manage-paywall',
      label: state === 'published_no_bundle' ? 'Add recipe' : 'Manage recipe',
      href: buildPostRecipeManagementPath(linkedPost),
    },
    secondaryAction: {
      type: 'open-post',
      label: 'Open post',
      href: buildCreationOpenPostPath(linkedPost),
    },
  };
}

export type CreationMediaFilter = 'all' | 'images' | 'videos' | 'audio';

/** A media filter of one kind: every one but All. */
export type CreationMediaKindFilter = Exclude<CreationMediaFilter, 'all'>;

/** The number each media filter shows: its total, or null where Studio does not know it. */
export type CreationMediaTotals = Record<CreationMediaFilter, number | null>;

/** A Studio filter's words: its name, with its total where Studio knows it. */
function formatStudioFilterLabel(name: string, total: number | null): string {
  return total === null ? name : `${name} (${total})`;
}

/**
 * Studio's media filters, with their numbers. Which filters there are follows
 * `counts`, what the loaded pages hold: a kind with nothing in it is no filter
 * ("Audio (0)" could only ever show nothing), except the one chosen: when its
 * last item goes, it stays, at 0, over its empty state, so the choice does not
 * vanish from under the reader. The number each shows is its total from
 * `totals` (`getStudioCreationCounts`), and none where the total is unknown.
 */
export function getCreationMediaFilters(
  counts: Record<CreationMediaFilter, number>,
  chosen: CreationMediaFilter,
  totals: CreationMediaTotals = counts,
): Array<{ key: CreationMediaFilter; label: string }> {
  const names: Record<CreationMediaFilter, string> = { all: 'All', images: 'Images', videos: 'Videos', audio: 'Audio' };
  return (Object.keys(names) as CreationMediaFilter[])
    .filter((key) => key === 'all' || counts[key] > 0 || key === chosen)
    .map((key) => ({ key, label: formatStudioFilterLabel(names[key], totals[key]) }));
}

/** A total Studio draws in a header. */
export interface StudioTotal {
  /** The total, or null before anything has answered. */
  total: number | null;
  /** Whether `total` counts only the pages loaded, with more maybe to come: drawn with a "+". */
  totalIsAtLeast: boolean;
}

/** A Studio list's counts: its total, and each filter's. */
export interface StudioListCounts<Filter extends string> extends StudioTotal {
  /** Each filter's total, or null where Studio does not know it: the filter then shows no number. */
  filterTotals: Record<Filter, number | null>;
}

/**
 * A Studio list's counts, for its header and its filters together, so the two
 * agree. Studio loads its creations and its posts 36 at a time, and its
 * filters counted the loaded pages: "All (29)" under "54 CREATIONS TOTAL"
 * (live sweep, 2026-11-17), and the Post Library's header and visibility
 * filters too. A number is drawn only where it is a total:
 * - every page loaded, and the server, read with the list, counting as many:
 *   the loaded rows are the library, so each count is its total;
 * - otherwise, the server's totals (`owner_profile_counts`, which counts by
 *   the list's own rules): its total is the header's and All's, and each
 *   filter's is the filter's where the server counts every filter of the list
 *   (`serverFilterTotals`) and they add up to its total, as they do when read
 *   together; a filter the server does not count (a database from before
 *   20261117192621) shows no number, and so does every filter of a split that
 *   no longer adds up. Where a loaded list and the server disagree, either can
 *   be the older: a later page's creations are kept as they were when the
 *   first is reread, so one archived elsewhere still counts in the list, while
 *   the totals come with the first page, and a page loaded after it can be
 *   newer. The server's numbers are drawn until a refresh reads both again;
 * - no server total (it could not count) once the list has answered: the
 *   header says what is loaded with a "+", and no filter a number;
 * - before anything has answered, no number at all (`total` null), never 0.
 */
export function getStudioListCounts<Filter extends string>({
  loaded,
  listAnswered,
  listComplete,
  serverTotal,
  serverFilterTotals = null,
}: {
  /** What the loaded pages hold, by filter; `all` is the list's own count. */
  loaded: Record<Filter | 'all', number>;
  /** Whether the list has answered, from the server or from a snapshot of an earlier visit. */
  listAnswered: boolean;
  /** Whether the list's last page is loaded: the server said no page follows it. */
  listComplete: boolean;
  /** The library's total from `/api/profile` (`stats`), or null when unread. */
  serverTotal: number | null;
  /**
   * Each filter's total, read with `serverTotal` (`stats.creationsByKind`,
   * `stats.postsByVisibility`), or null where the server does not count them.
   */
  serverFilterTotals?: Partial<Record<Filter, number>> | null;
}): StudioListCounts<Filter | 'all'> {
  // No filter's total known but All's, which may be unknown too.
  const allKnownOnly = (all: number | null) => Object.fromEntries(
    Object.keys(loaded).map((key) => [key, key === 'all' ? all : null]),
  ) as Record<Filter | 'all', number | null>;
  // The server's totals: All's, and each filter's where it counts them all and they add up to All's.
  const serverCounts = (all: number) => {
    const filters = Object.keys(loaded).filter((key) => key !== 'all') as Filter[];
    const split = filters.map((key) => serverFilterTotals?.[key]);
    if (
      serverFilterTotals === null
      || !split.every((count): count is number => typeof count === 'number' && Number.isFinite(count))
      || split.reduce((sum, count) => sum + count, 0) !== all
    ) {
      return allKnownOnly(all);
    }
    return Object.fromEntries([
      ['all', all],
      ...filters.map((key, index) => [key, split[index]]),
    ]) as Record<Filter | 'all', number | null>;
  };
  if (listComplete && (serverTotal === null || serverTotal === loaded.all)) {
    return { total: loaded.all, totalIsAtLeast: false, filterTotals: { ...loaded } };
  }
  if (serverTotal !== null) {
    return { total: serverTotal, totalIsAtLeast: false, filterTotals: serverCounts(serverTotal) };
  }
  if (listAnswered) {
    return { total: loaded.all, totalIsAtLeast: true, filterTotals: allKnownOnly(null) };
  }
  return { total: null, totalIsAtLeast: false, filterTotals: allKnownOnly(null) };
}

/**
 * Studio's creation counts, for its header and its media filters
 * (`getStudioListCounts`). The server counts the finished creations
 * (`stats.creations`) and, since 20261117192621, each kind of them
 * (`stats.creationsByKind`), filed as the owner list files a creation: Images,
 * Videos and Audio say their totals while pages wait.
 */
export function getStudioCreationCounts({
  serverKindTotals = null,
  ...input
}: {
  /** The finished creations the loaded pages hold, by filter. */
  loaded: Record<CreationMediaFilter, number>;
  listAnswered: boolean;
  listComplete: boolean;
  /** The library's total from `/api/profile` (`stats.creations`), or null when unread. */
  serverTotal: number | null;
  /** Its kinds (`stats.creationsByKind`), or null where the server does not count them. */
  serverKindTotals?: OwnerCreationKindTotals | null;
}): StudioListCounts<CreationMediaFilter> {
  return getStudioListCounts({ ...input, serverFilterTotals: serverKindTotals });
}

/** The media filter a creation of a kind is listed under, as Studio's grid files it. */
export function getCreationMediaKindFilter(kind: 'image' | 'video' | 'audio'): CreationMediaKindFilter {
  return kind === 'image' ? 'images' : kind === 'video' ? 'videos' : 'audio';
}

/**
 * The server's creation totals Studio holds, moved by a change it made to one
 * finished creation (archived, restored or deleted there): the Active total,
 * and its kind's where the server counts kinds, so the two still add up.
 */
export function moveStudioCreationTotals(
  stats: OwnerProfileStats,
  kind: CreationMediaKindFilter,
  delta: number,
): OwnerProfileStats {
  return {
    ...stats,
    creations: Math.max(0, stats.creations + delta),
    ...(stats.creationsByKind
      ? { creationsByKind: { ...stats.creationsByKind, [kind]: Math.max(0, stats.creationsByKind[kind] + delta) } }
      : {}),
  };
}

/** The Post Library's filters: every live post, one per visibility, and the archived ones. */
export type StudioPostFilter = 'all' | 'public' | 'unlisted' | 'private' | 'archived';

/** The number each visibility filter shows: its total, or null where Studio does not know it. */
export type StudioPostTotals = Record<StudioPostFilter, number | null>;

/**
 * The Post Library's counts, for its header ("42 POSTS · 8 ARCHIVED") and its
 * visibility filters together, by the rule of `getStudioListCounts`. The owner
 * list holds every post, archived ones too, so the totals the server counts
 * (`owner_profile_counts`: `posts`, the live ones, split by visibility in
 * `postsByVisibility`, and `archivedPosts`) are each read against the posts
 * loaded on its side of the archive: All, Public, Unlisted, Private and
 * Archived say them while pages wait. A database from before the split
 * (20261117192621) leaves Public, Unlisted and Private no number until every
 * page is loaded.
 */
export function getStudioPostCounts({
  loaded,
  listAnswered,
  listComplete,
  serverTotals,
}: {
  /** The posts the loaded pages hold, by filter: `all` counts the live ones, as the All filter lists. */
  loaded: Record<StudioPostFilter, number>;
  /** Whether the list has answered, from the server or from a snapshot of an earlier visit. */
  listAnswered: boolean;
  /** Whether the list's last page is loaded: the server said no page follows it. */
  listComplete: boolean;
  /** The library's totals from `/api/profile` (`stats`), or null when unread. */
  serverTotals: { posts: number; archivedPosts: number; postsByVisibility?: OwnerPostVisibilityTotals } | null;
}): { live: StudioTotal; archived: StudioTotal; filterTotals: StudioPostTotals } {
  const { archived: loadedArchived, ...loadedLive } = loaded;
  const live = getStudioListCounts({
    loaded: loadedLive,
    listAnswered,
    listComplete,
    serverTotal: serverTotals?.posts ?? null,
    serverFilterTotals: serverTotals?.postsByVisibility ?? null,
  });
  const archived = getStudioListCounts({
    loaded: { all: loadedArchived },
    listAnswered,
    listComplete,
    serverTotal: serverTotals?.archivedPosts ?? null,
  });
  return {
    live: { total: live.total, totalIsAtLeast: live.totalIsAtLeast },
    archived: { total: archived.total, totalIsAtLeast: archived.totalIsAtLeast },
    filterTotals: { ...live.filterTotals, archived: archived.filterTotals.all },
  };
}

/** Where a post counts in the server's post totals: under its visibility while it is live, or archived. */
export interface StudioPostPlace {
  visibility: 'public' | 'unlisted' | 'private';
  archivedAt: string | null;
}

/**
 * The server's post totals Studio holds, moved by a change it made to one post
 * (its visibility changed, archived, restored or deleted there): from where the
 * post counted (`before`) to where it counts now (`after`, null once deleted),
 * the live or archived total and its visibility's where the server counts them.
 * The same stats when the post's place did not change.
 */
export function moveStudioPostTotals(
  stats: OwnerProfileStats,
  before: StudioPostPlace | null,
  after: StudioPostPlace | null,
): OwnerProfileStats {
  const place = (post: StudioPostPlace | null) => (post === null ? null : post.archivedAt ? 'archived' : post.visibility);
  const from = place(before);
  const to = place(after);
  if (from === to) return stats;
  const step = (key: NonNullable<typeof from>) => (to === key ? 1 : 0) - (from === key ? 1 : 0);
  const isLive = (key: typeof from) => key !== null && key !== 'archived';
  const byVisibility = stats.postsByVisibility;
  return {
    ...stats,
    posts: Math.max(0, stats.posts + (isLive(to) ? 1 : 0) - (isLive(from) ? 1 : 0)),
    archivedPosts: Math.max(0, stats.archivedPosts + step('archived')),
    ...(byVisibility
      ? {
        postsByVisibility: {
          public: Math.max(0, byVisibility.public + step('public')),
          unlisted: Math.max(0, byVisibility.unlisted + step('unlisted')),
          private: Math.max(0, byVisibility.private + step('private')),
        },
      }
      : {}),
  };
}

/**
 * The Post Library's visibility filters, with their numbers. Which filters
 * there are follows `counts`, what the loaded pages hold: a post is public or
 * private since 2026-10-17 (decision 12), so Unlisted is a filter only while a
 * post saved as one is left, or while it is the one chosen. The number each
 * shows is its total from `totals` (`getStudioPostCounts`), and none where the
 * total is unknown.
 */
export function getStudioPostFilters(
  counts: Record<StudioPostFilter, number>,
  chosen: StudioPostFilter,
  totals: StudioPostTotals = counts,
): Array<{ key: StudioPostFilter; label: string }> {
  const names: Record<StudioPostFilter, string> = {
    all: 'All',
    public: 'Public',
    unlisted: 'Unlisted',
    private: 'Private',
    archived: 'Archived',
  };
  return (Object.keys(names) as StudioPostFilter[])
    .filter((key) => key !== 'unlisted' || counts.unlisted > 0 || key === chosen)
    .map((key) => ({ key, label: formatStudioFilterLabel(names[key], totals[key]) }));
}
