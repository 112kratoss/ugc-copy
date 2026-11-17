import { describe, expect, it } from 'vitest';

import {
  buildPostRecipeManagementPath,
  getCreationMediaFilters,
  getStudioCreationCounts,
  getStudioPostCounts,
  getStudioPostFilters,
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

// The Post Library loads its posts 36 at a time too, and its header and visibility filters counted
// the loaded pages: "31 POSTS · 5 ARCHIVED" over "All (31)" and "Public (22)" for a library of 42
// posts and 8 archived ones (#836's note; studio-counts-and-first-screen.spec.ts draws it).
describe('getStudioPostCounts', () => {
  const firstPage = { all: 31, public: 22, unlisted: 0, private: 9, archived: 5 };
  const everyPage = { all: 42, public: 30, unlisted: 1, private: 11, archived: 8 };
  const library = { posts: 42, archivedPosts: 8 };
  const unknown = { all: null, public: null, unlisted: null, private: null, archived: null };
  const exact = (total: number) => ({ total, totalIsAtLeast: false });

  it("says the server's totals in the header, on All and on Archived while pages wait, and no visibility's number", () => {
    expect(getStudioPostCounts({ loaded: firstPage, listAnswered: true, listComplete: false, serverTotals: library })).toEqual({
      live: exact(42),
      archived: exact(8),
      filterTotals: { ...unknown, all: 42, archived: 8 },
    });
  });

  it('counts what is loaded once every page is and the server counts as many, every number a total', () => {
    expect(getStudioPostCounts({ loaded: everyPage, listAnswered: true, listComplete: true, serverTotals: library })).toEqual({
      live: exact(42),
      archived: exact(8),
      filterTotals: everyPage,
    });
    // The server could not count: nothing says the list is behind.
    expect(getStudioPostCounts({ loaded: everyPage, listAnswered: true, listComplete: true, serverTotals: null }))
      .toEqual({ live: exact(42), archived: exact(8), filterTotals: everyPage });
  });

  it('reads each side of the archive against its own total', () => {
    // A live post the list does not know of yet: the live side believes the server, and draws no
    // visibility's number; the archived side agrees, and keeps its own.
    expect(getStudioPostCounts({
      loaded: everyPage,
      listAnswered: true,
      listComplete: true,
      serverTotals: { posts: 43, archivedPosts: 8 },
    })).toEqual({ live: exact(43), archived: exact(8), filterTotals: { ...unknown, all: 43, archived: 8 } });
    expect(getStudioPostCounts({
      loaded: everyPage,
      listAnswered: true,
      listComplete: true,
      serverTotals: { posts: 42, archivedPosts: 9 },
    })).toEqual({ live: exact(42), archived: exact(9), filterTotals: { ...everyPage, archived: 9 } });
  });

  it('says what is loaded with a "+" when the server could not count, and no filter a number', () => {
    expect(getStudioPostCounts({ loaded: firstPage, listAnswered: true, listComplete: false, serverTotals: null })).toEqual({
      live: { total: 31, totalIsAtLeast: true },
      archived: { total: 5, totalIsAtLeast: true },
      filterTotals: unknown,
    });
  });

  it('says no number at all before anything has answered', () => {
    expect(getStudioPostCounts({
      loaded: { all: 0, public: 0, unlisted: 0, private: 0, archived: 0 },
      listAnswered: false,
      listComplete: false,
      serverTotals: null,
    })).toEqual({
      live: { total: null, totalIsAtLeast: false },
      archived: { total: null, totalIsAtLeast: false },
      filterTotals: unknown,
    });
  });
});

describe('getStudioPostFilters', () => {
  const labels = (filters: ReturnType<typeof getStudioPostFilters>) => filters.map((filter) => filter.label);

  it('offers Unlisted only while a post saved as one is left, or while it is the one chosen', () => {
    // A post is public or private since 2026-10-17 (decision 12).
    expect(labels(getStudioPostFilters({ all: 3, public: 2, unlisted: 0, private: 1, archived: 1 }, 'all')))
      .toEqual(['All (3)', 'Public (2)', 'Private (1)', 'Archived (1)']);
    expect(labels(getStudioPostFilters({ all: 3, public: 1, unlisted: 1, private: 1, archived: 0 }, 'all')))
      .toEqual(['All (3)', 'Public (1)', 'Unlisted (1)', 'Private (1)', 'Archived (0)']);
    expect(getStudioPostFilters({ all: 0, public: 0, unlisted: 0, private: 0, archived: 2 }, 'unlisted')).toEqual([
      { key: 'all', label: 'All (0)' },
      { key: 'public', label: 'Public (0)' },
      { key: 'unlisted', label: 'Unlisted (0)' },
      { key: 'private', label: 'Private (0)' },
      { key: 'archived', label: 'Archived (2)' },
    ]);
  });

  it('draws a filter with no number where its total is not known', () => {
    expect(labels(getStudioPostFilters(
      { all: 31, public: 22, unlisted: 0, private: 9, archived: 5 },
      'private',
      { all: 42, public: null, unlisted: null, private: null, archived: 8 },
    ))).toEqual(['All (42)', 'Public', 'Private', 'Archived (8)']);
  });
});
