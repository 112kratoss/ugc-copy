import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import UnlockDetail from '@/app/unlocks/[postId]/UnlockDetail';

const { panelProps } = vi.hoisted(() => ({ panelProps: vi.fn() }));

vi.mock('@/app/showcase/[id]/PostResourceBundlePanel', () => ({
  default: (props: unknown) => {
    panelProps(props);
    return null;
  },
}));

vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const currentResources = {
  promptText: 'Latest prompt',
  notesMarkdown: null,
  workflowShareUrl: null,
  workflowSnapshot: null,
  attachments: [],
  allowRemix: false,
  sections: [],
  items: [],
};

describe('UnlockDetail', () => {
  beforeEach(() => {
    panelProps.mockClear();
  });

  it('forwards proof media, unknown sales, and complete revision metadata', () => {
    const mediaItems = [
      { id: 'media-1', mediaKey: 'proof-one', url: '/one.jpg', mediaKind: 'image', sortOrder: 0 },
      { id: 'media-2', mediaKey: 'proof-two', url: '/two.jpg', mediaKind: 'image', sortOrder: 1 },
    ];

    render(<UnlockDetail detail={{
      unlockId: 'unlock-1',
      bundleId: 'bundle-1',
      postId: 'post-1',
      title: 'Latest title',
      summary: 'Latest summary',
      previewText: 'Latest preview',
      accessMode: 'paid',
      priceUsdCents: 900,
      purchasePriceUsdCents: 500,
      salesCount: null,
      purchasedAt: '2026-07-02T00:00:00.000Z',
      creatorDisplayName: 'Creator',
      resourceKinds: ['prompt'],
      currentResources,
      purchasedRevision: {
        revisionId: 'revision-1',
        revisionNumber: 2,
        createdAt: '2026-07-01T00:00:00.000Z',
        title: 'Purchased title',
        summary: 'Purchased summary',
        previewText: 'Purchased preview',
        accessMode: 'free',
        priceUsdCents: 0,
        mediaItems: mediaItems.slice(0, 1),
        resources: { ...currentResources, promptText: 'Purchased prompt' },
      },
      hasNewerRevision: true,
      detached: false,
      retired: false,
      tombstoned: false,
      postVisibility: 'public',
      post: null,
      mediaItems,
    } as never} />);

    expect(panelProps).toHaveBeenCalledWith(expect.objectContaining({
      mediaItems,
      salesCount: null,
      purchasedRevision: expect.objectContaining({
        title: 'Purchased title',
        summary: 'Purchased summary',
        previewText: 'Purchased preview',
        accessMode: 'free',
        priceUsdCents: 0,
        mediaItems: mediaItems.slice(0, 1),
      }),
    }));
  });
});
