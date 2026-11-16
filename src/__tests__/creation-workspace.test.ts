import { describe, expect, it } from 'vitest';

import {
  buildPostRecipeManagementPath,
  getCreationMediaFilters,
  getStudioCreationCounts,
  resolveCreationWorkspaceCardState,
} from '@/lib/creation-workspace';

const baseGeneration = {
  id: 'gen-1',
  archived_at: null,
  linked_post_id: null,
  linked_post_title: null,
  linked_post_visibility: null,
  linked_post_archived_at: null,
} as const;

describe('resolveCreationWorkspaceCardState', () => {
  it('returns publish and set-paywall actions for unpublished creations', () => {
    const state = resolveCreationWorkspaceCardState(baseGeneration, []);

    expect(state.state).toBe('unpublished');
    expect(state.publishBadge).toBe('Not published');
    expect(state.monetizationLabel).toBe('No recipe');
    // Publish opens the full composer for the creation, as the app's does.
    expect(state.primaryAction).toMatchObject({
      type: 'publish',
      label: 'Publish',
      href: '/post/new?generationId=gen-1&from=creations',
    });
    expect(state.secondaryAction).toMatchObject({
      type: 'set-paywall',
      label: 'Add paid recipe',
      href: '/post/new?generationId=gen-1&publishIntent=paid-generation&resourceMode=paid&focus=price&from=creations',
    });
  });

  it('returns add-paywall and open-post actions for published creations without a bundle', () => {
    const state = resolveCreationWorkspaceCardState(baseGeneration, [
      {
        id: 'post-1',
        generationId: 'gen-1',
        visibility: 'public',
        archivedAt: null,
        title: 'Linked post',
        publicPath: '/showcase/post-1',
        ownerPath: '/post/post-1/edit',
        canShare: true,
        bundle: null,
      },
    ]);

    expect(state.state).toBe('published_no_bundle');
    expect(state.publishBadge).toBe('Public');
    expect(state.monetizationLabel).toBe('No recipe');
    // A-F17: adding a recipe chooses no mode for the creator and focuses no
    // price; the editor heads the page "Add a recipe to this post".
    expect(state.primaryAction).toMatchObject({
      type: 'add-paywall',
      label: 'Add recipe',
      href: '/post/post-1/edit?recipe=add&from=creations#recipe',
    });
    expect(state.secondaryAction).toMatchObject({
      type: 'open-post',
      label: 'Open post',
      href: '/showcase/post-1?from=studio&returnTo=%2Fcreations',
    });
  });

  it('surfaces free unlock state and keeps management inside the owner editor', () => {
    const state = resolveCreationWorkspaceCardState(baseGeneration, [
      {
        id: 'post-free',
        generationId: 'gen-1',
        visibility: 'private',
        archivedAt: null,
        title: 'Private post',
        publicPath: null,
        ownerPath: '/post/post-free/edit',
        canShare: false,
        bundle: {
          accessMode: 'free',
          status: 'published',
          priceUsdCents: 0,
        },
      },
    ]);

    expect(state.state).toBe('published_free_bundle');
    expect(state.publishBadge).toBe('Private');
    expect(state.monetizationKind).toBe('free');
    expect(state.monetizationLabel).toBe('Free recipe');
    expect(state.primaryAction.href).toBe('/post/post-free/edit?resourceMode=free&focus=price&from=creations#recipe');
    expect(state.secondaryAction.href).toBe('/post/post-free/edit');
  });

  it('surfaces paid unlock pricing for live bundles', () => {
    const state = resolveCreationWorkspaceCardState(baseGeneration, [
      {
        id: 'post-paid',
        generationId: 'gen-1',
        visibility: 'unlisted',
        archivedAt: null,
        title: 'Paid post',
        publicPath: '/showcase/post-paid',
        ownerPath: '/post/post-paid/edit',
        canShare: true,
        bundle: {
          accessMode: 'paid',
          status: 'published',
          priceUsdCents: 2400,
        },
      },
    ]);

    expect(state.state).toBe('published_paid_bundle');
    expect(state.publishBadge).toBe('Unlisted');
    expect(state.monetizationKind).toBe('paid');
    expect(state.monetizationPriceUsdCents).toBe(2400);
    expect(state.primaryAction.label).toBe('Manage recipe');
  });

  it('surfaces draft bundle state separately from live unlocks', () => {
    const state = resolveCreationWorkspaceCardState(baseGeneration, [
      {
        id: 'post-draft',
        generationId: 'gen-1',
        visibility: 'public',
        archivedAt: '2026-04-15T10:00:00.000Z',
        title: 'Draft post',
        publicPath: null,
        ownerPath: '/post/post-draft/edit',
        canShare: false,
        bundle: {
          accessMode: 'paid',
          status: 'draft',
          priceUsdCents: 900,
        },
      },
    ]);

    expect(state.state).toBe('published_bundle_draft');
    expect(state.publishBadge).toBe('Archived');
    expect(state.monetizationKind).toBe('draft');
    expect(state.monetizationLabel).toBe('Recipe draft');
    expect(state.secondaryAction.href).toBe('/post/post-draft/edit');
  });

  // Studio loads the newest page of posts only. A creation whose post is older
  // than that page used to read "No recipe" with an "Add recipe" button even
  // when the post sold one; the creations list now sends the bundle beside the
  // linked post.
  describe('a linked post older than the loaded posts', () => {
    const olderLinkedGeneration = {
      ...baseGeneration,
      linked_post_id: 'post-old',
      linked_post_title: 'Older paid post',
      linked_post_visibility: 'public',
      linked_post_archived_at: null,
    } as const;

    it('reads a paid published recipe from the list and offers to manage it', () => {
      const state = resolveCreationWorkspaceCardState({
        ...olderLinkedGeneration,
        linked_post_bundle: { accessMode: 'paid', status: 'published', priceUsdCents: 2400 },
      }, []);

      expect(state.state).toBe('published_paid_bundle');
      expect(state.monetizationKind).toBe('paid');
      expect(state.monetizationLabel).toBe('Paid recipe');
      expect(state.monetizationPriceUsdCents).toBe(2400);
      expect(state.primaryAction).toEqual({
        type: 'manage-paywall',
        label: 'Manage recipe',
        href: '/post/post-old/edit?resourceMode=paid&focus=price&from=creations#recipe',
      });
    });

    it('reads a free recipe and a draft the way a loaded post reads them', () => {
      const free = resolveCreationWorkspaceCardState({
        ...olderLinkedGeneration,
        linked_post_bundle: { accessMode: 'free', status: 'published', priceUsdCents: 0 },
      }, []);
      expect(free.monetizationLabel).toBe('Free recipe');
      expect(free.primaryAction.href).toBe('/post/post-old/edit?resourceMode=free&focus=price&from=creations#recipe');

      const draft = resolveCreationWorkspaceCardState({
        ...olderLinkedGeneration,
        linked_post_bundle: { accessMode: 'paid', status: 'draft', priceUsdCents: 900 },
      }, []);
      expect(draft.state).toBe('published_bundle_draft');
      expect(draft.monetizationLabel).toBe('Recipe draft');
      expect(draft.primaryAction.label).toBe('Manage recipe');
    });

    it('offers Add recipe only when the list says the post has none', () => {
      for (const linkedPostBundle of [null, undefined]) {
        const state = resolveCreationWorkspaceCardState({
          ...olderLinkedGeneration,
          linked_post_bundle: linkedPostBundle,
        }, []);
        expect(state.state).toBe('published_no_bundle');
        expect(state.monetizationLabel).toBe('No recipe');
        expect(state.primaryAction.label).toBe('Add recipe');
        expect(state.primaryAction.href).toBe('/post/post-old/edit?recipe=add&from=creations#recipe');
      }
    });

    // Studio's posts tab builds its Add / Manage recipe link from the post.
    it('builds the add path for a post without a recipe and the manage path otherwise', () => {
      expect(buildPostRecipeManagementPath({ id: 'post-9', bundle: null })).toBe(
        '/post/post-9/edit?recipe=add&from=creations#recipe',
      );
      expect(buildPostRecipeManagementPath({ id: 'post-9', bundle: { accessMode: 'free' } })).toBe(
        '/post/post-9/edit?resourceMode=free&focus=price&from=creations#recipe',
      );
    });

    it('lets a loaded post answer for itself', () => {
      const state = resolveCreationWorkspaceCardState({
        ...olderLinkedGeneration,
        linked_post_bundle: { accessMode: 'paid', status: 'published', priceUsdCents: 2400 },
      }, [{
        id: 'post-old',
        generationId: 'gen-1',
        visibility: 'public',
        archivedAt: null,
        title: 'Older paid post',
        publicPath: '/showcase/post-old',
        ownerPath: '/post/post-old/edit',
        canShare: true,
        bundle: { accessMode: 'free', status: 'published', priceUsdCents: 0 },
      }]);

      expect(state.monetizationKind).toBe('free');
    });
  });
});

describe('getCreationMediaFilters', () => {
  const labels = (filters: ReturnType<typeof getCreationMediaFilters>) => filters.map((filter) => filter.label);

  it('offers a filter only for a kind there is something of', () => {
    // "Audio (0)" and "Videos (0)" could only ever show nothing.
    expect(labels(getCreationMediaFilters({ all: 3, images: 3, videos: 0, audio: 0 }, 'all'))).toEqual(['All (3)', 'Images (3)']);
    expect(labels(getCreationMediaFilters({ all: 5, images: 3, videos: 2, audio: 0 }, 'all'))).toEqual(['All (5)', 'Images (3)', 'Videos (2)']);
  });

  it('keeps the kind chosen when its last item goes, at 0, over its empty state', () => {
    expect(getCreationMediaFilters({ all: 3, images: 3, videos: 0, audio: 0 }, 'videos')).toEqual([
      { key: 'all', label: 'All (3)' },
      { key: 'images', label: 'Images (3)' },
      { key: 'videos', label: 'Videos (0)' },
    ]);
  });

  it('always offers All, with nothing in it too', () => {
    expect(labels(getCreationMediaFilters({ all: 0, images: 0, videos: 0, audio: 0 }, 'all'))).toEqual(['All (0)']);
  });

  it('draws a filter with no number where its total is not known', () => {
    expect(labels(getCreationMediaFilters(
      { all: 29, images: 29, videos: 0, audio: 0 },
      'all',
      { all: 54, images: null, videos: null, audio: null },
    ))).toEqual(['All (54)', 'Images']);
    // Which filters there are still follows what is loaded: a kind with nothing loaded has none.
    expect(labels(getCreationMediaFilters(
      { all: 29, images: 29, videos: 0, audio: 0 },
      'videos',
      { all: null, images: null, videos: null, audio: null },
    ))).toEqual(['All', 'Images', 'Videos']);
  });
});

// The live sweep of 2026-11-17: "54 CREATIONS TOTAL" over "All (29)" and "Images (29)", the 29
// counting the finished creations of the one page of 36 loaded.
describe('getStudioCreationCounts', () => {
  const firstPage = { all: 29, images: 29, videos: 0, audio: 0 };
  const unknown = { all: null, images: null, videos: null, audio: null };

  it("says the server's total in the header and on All while pages wait, and no number for a kind", () => {
    expect(getStudioCreationCounts({ loaded: firstPage, listAnswered: true, listComplete: false, serverTotal: 54 })).toEqual({
      total: 54,
      totalIsAtLeast: false,
      filterTotals: { ...unknown, all: 54 },
    });
  });

  it('counts what is loaded once every page is and the server counts as many, the whole library', () => {
    const everyPage = { all: 54, images: 47, videos: 7, audio: 0 };
    expect(getStudioCreationCounts({ loaded: everyPage, listAnswered: true, listComplete: true, serverTotal: 54 })).toEqual({
      total: 54,
      totalIsAtLeast: false,
      filterTotals: everyPage,
    });
    // The server could not count: nothing says the list is behind.
    expect(getStudioCreationCounts({ loaded: everyPage, listAnswered: true, listComplete: true, serverTotal: null }))
      .toMatchObject({ total: 54, filterTotals: everyPage });
  });

  // Review of #836: with every page loaded, a creation of the second page archived since stayed
  // active in the list, as a reread of the first page keeps a later page's rows as they were, and
  // the header said 54 where the server, read in the same refresh, said 53.
  it("believes the server over a loaded list it disagrees with, and then says no kind's number", () => {
    const everyPage = { all: 54, images: 47, videos: 7, audio: 0 };
    expect(getStudioCreationCounts({ loaded: everyPage, listAnswered: true, listComplete: true, serverTotal: 53 })).toEqual({
      total: 53,
      totalIsAtLeast: false,
      filterTotals: { ...unknown, all: 53 },
    });
  });

  it('says what is loaded with a "+" when the server could not count, and no filter number', () => {
    expect(getStudioCreationCounts({ loaded: firstPage, listAnswered: true, listComplete: false, serverTotal: null })).toEqual({
      total: 29,
      totalIsAtLeast: true,
      filterTotals: unknown,
    });
  });

  // Review of #836: "0+ CREATIONS TOTAL" in the server's HTML and until the list answered.
  it('says no number at all before anything has answered', () => {
    expect(getStudioCreationCounts({
      loaded: { all: 0, images: 0, videos: 0, audio: 0 },
      listAnswered: false,
      listComplete: false,
      serverTotal: null,
    })).toEqual({ total: null, totalIsAtLeast: false, filterTotals: unknown });
  });
});
