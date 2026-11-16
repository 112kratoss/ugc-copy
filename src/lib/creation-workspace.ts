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

/** The number each media filter shows: its total, or null where Studio does not know it. */
export type CreationMediaTotals = Record<CreationMediaFilter, number | null>;

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
    .map((key) => {
      const total = totals[key];
      return { key, label: total === null ? names[key] : `${names[key]} (${total})` };
    });
}

/**
 * Studio's creation counts, for its header and its media filters together, so
 * the two agree. Studio loads its creations 36 at a time, and its filters
 * counted the loaded pages: "All (29)" under "54 CREATIONS TOTAL" (live sweep,
 * 2026-11-17). A number is drawn only where it is a total:
 * - every page loaded, and the server, read with the list, counting as many:
 *   the loaded creations are the library, so each count is its total;
 * - otherwise, the server's total (`owner_profile_counts`, which counts by the
 *   grid's own rule) is the header's and All's, and a kind, which the server
 *   does not count, shows no number. A loaded list the server disagrees with
 *   is behind it: a later page's rows are kept as they were when the first is
 *   reread, so one archived elsewhere still counts;
 * - no server total (it could not count) once the list has answered: the
 *   header says what is loaded with a "+", and no filter a number;
 * - before anything has answered, no number at all (`total` null), never 0.
 */
export function getStudioCreationCounts({
  loaded,
  listAnswered,
  listComplete,
  serverTotal,
}: {
  /** The finished creations the loaded pages hold, by filter. */
  loaded: Record<CreationMediaFilter, number>;
  /** Whether the list has answered, from the server or from a snapshot of an earlier visit. */
  listAnswered: boolean;
  /** Whether the list's last page is loaded: the server said no page follows it. */
  listComplete: boolean;
  /** The library's total from `/api/profile` (`stats.creations`), or null when unread. */
  serverTotal: number | null;
}): { total: number | null; totalIsAtLeast: boolean; filterTotals: CreationMediaTotals } {
  const unknown: CreationMediaTotals = { all: null, images: null, videos: null, audio: null };
  if (listComplete && (serverTotal === null || serverTotal === loaded.all)) {
    return { total: loaded.all, totalIsAtLeast: false, filterTotals: { ...loaded } };
  }
  if (serverTotal !== null) {
    return { total: serverTotal, totalIsAtLeast: false, filterTotals: { ...unknown, all: serverTotal } };
  }
  if (listAnswered) {
    return { total: loaded.all, totalIsAtLeast: true, filterTotals: unknown };
  }
  return { total: null, totalIsAtLeast: false, filterTotals: unknown };
}
