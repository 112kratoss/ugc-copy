import { describe, expect, it } from 'vitest';

import { resolveCreationWorkspaceCardState } from '@/lib/creation-workspace';

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
    expect(state.monetizationLabel).toBe('No unlock');
    expect(state.primaryAction).toMatchObject({
      type: 'publish',
      label: 'Publish',
      href: null,
    });
    expect(state.secondaryAction).toMatchObject({
      type: 'set-paywall',
      label: 'Add paid unlock',
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
    expect(state.monetizationLabel).toBe('No unlock');
    expect(state.primaryAction).toMatchObject({
      type: 'add-paywall',
      label: 'Add unlock',
      href: '/post/post-1/edit?resourceMode=paid&focus=price&from=creations#resources',
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
    expect(state.monetizationLabel).toBe('Free unlock');
    expect(state.primaryAction.href).toBe('/post/post-free/edit?resourceMode=free&focus=price&from=creations#resources');
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
    expect(state.primaryAction.label).toBe('Manage unlock');
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
    expect(state.monetizationLabel).toBe('Unlock draft');
    expect(state.secondaryAction.href).toBe('/post/post-draft/edit');
  });
});
