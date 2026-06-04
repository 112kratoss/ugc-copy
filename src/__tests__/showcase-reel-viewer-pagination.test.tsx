import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseReelViewer from '@/app/showcase/ShowcaseReelViewer';
import type { ShowcaseFeedItem } from '@/lib/showcase';

vi.mock('next/link', () => ({
  default: ({
    href,
    prefetch,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: boolean;
    children: ReactNode;
  }) => (
    <a
      href={href}
      data-prefetch={prefetch === undefined ? undefined : String(prefetch)}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    span: ({ children, ...props }: HTMLAttributes<HTMLSpanElement>) => <span {...props}>{children}</span>,
  },
  useReducedMotion: () => false,
}));

vi.mock('@/app/components/PublicShareButton', () => ({
  default: ({ label, className }: { label?: string; className?: string }) => (
    <button type="button" className={className}>
      {label ?? 'Share'}
    </button>
  ),
}));

function createShowcaseItem(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: 'https://example.com/image.jpg',
    mediaKind: 'image',
    model: 'nano-banana-2',
    title: 'Campaign Frame',
    prompt: 'A creator-style product shot by a bright window.',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 4,
    remixCount: 2,
    createdAt: '2026-03-28T10:00:00.000Z',
    creator: {
      id: 'creator-1',
      username: 'creator-name',
      name: 'Creator Name',
      avatar: null,
    },
    isSaved: false,
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: 'gen-1',
    asset: null,
    canRemix: false,
    ...overrides,
  };
}

describe('ShowcaseReelViewer pagination', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('requests another page when next is pressed at the last loaded reel item', async () => {
    const loadMoreItems = vi.fn(async () => undefined);

    render(
      <ShowcaseReelViewer
        isOpen
        items={[
          createShowcaseItem({ id: 'post-1', title: 'First Frame' }),
          createShowcaseItem({ id: 'post-2', title: 'Last Loaded Frame' }),
        ]}
        selectedItemId="post-2"
        savedItemIds={new Set()}
        savingItemIds={new Set()}
        accessToken={null}
        hasMoreItems
        isLoadingMoreItems={false}
        onLoadMoreItems={loadMoreItems}
        onClose={vi.fn()}
        onSelectItemId={vi.fn()}
        onToggleSave={vi.fn()}
        onRemix={vi.fn()}
        buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
      />
    );

    fireEvent.keyDown(window, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(loadMoreItems).toHaveBeenCalledTimes(1);
    });
  });
});
