import type { HTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import HomeShowcasePreviewGrid from '@/app/components/HomeShowcasePreviewGrid';
import type { ShowcaseFeedItem } from '@/lib/showcase';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: {
      access_token: 'test-token',
      user: { id: 'user-1' },
    },
    user: { id: 'user-1' },
    credits: 25,
    isLoading: false,
  }),
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

vi.mock('@/app/components/HoverVideo', () => ({
  HoverVideo: ({ src, className }: { src: string; className?: string }) => (
    <video data-testid="hover-video" src={src} className={className} />
  ),
}));

function createShowcaseItem(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'gen-1',
    mediaUrl: 'https://example.com/image.jpg',
    mediaKind: 'image',
    model: 'nano-banana-2',
    title: 'Campaign Frame',
    prompt: 'A creator-style product shot by a bright window.',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 8,
    remixCount: 3,
    createdAt: '2026-03-28T10:00:00.000Z',
    creator: {
      id: 'creator-1',
      username: 'creator-name',
      name: 'Creator Name',
      avatar: null,
    },
    isSaved: true,
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: 'gen-1',
    asset: null,
    canRemix: true,
    ...overrides,
  };
}

describe('HomeShowcasePreviewGrid', () => {
  beforeEach(() => {
    mockPush.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens the media preview modal from the homepage inspiration grid with action buttons', () => {
    const items: ShowcaseFeedItem[] = [createShowcaseItem()];

    render(<HomeShowcasePreviewGrid items={items} />);

    fireEvent.click(screen.getByRole('button', { name: /preview campaign frame/i }));

    const dialog = screen.getByRole('dialog', { name: /campaign frame/i });
    expect(within(dialog).getByText('A creator-style product shot by a bright window.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^share$/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /8 saves/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /3 remixes/i })).toBeInTheDocument();

    const openPageLink = within(dialog).getByRole('link', { name: /open public page/i });
    expect(openPageLink).toHaveAttribute('href', '/showcase/gen-1?from=home&returnTo=%2F');
  });

  it('optimistically saves and unsaves from the homepage modal with accessible state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true }),
    })));
    const items: ShowcaseFeedItem[] = [createShowcaseItem({ isSaved: false })];

    render(<HomeShowcasePreviewGrid items={items} />);

    fireEvent.click(screen.getByRole('button', { name: /preview campaign frame/i }));
    const dialog = screen.getByRole('dialog', { name: /campaign frame/i });
    const saveButton = within(dialog).getByRole('button', {
      name: /save campaign frame\. 8 saves/i,
    });
    expect(saveButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(within(dialog).getByRole('button', {
        name: /remove save from campaign frame\. 9 saves/i,
      })).toHaveAttribute('aria-pressed', 'true');
    });
    expect(fetch).toHaveBeenCalledWith('/api/showcase/save', expect.objectContaining({
      method: 'POST',
    }));
  });

  it('restores the homepage modal save state when saving fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'Nope' }),
    })));
    const items: ShowcaseFeedItem[] = [createShowcaseItem({ isSaved: false })];

    render(<HomeShowcasePreviewGrid items={items} />);

    fireEvent.click(screen.getByRole('button', { name: /preview campaign frame/i }));
    const dialog = screen.getByRole('dialog', { name: /campaign frame/i });
    fireEvent.click(within(dialog).getByRole('button', {
      name: /save campaign frame\. 8 saves/i,
    }));

    await waitFor(() => {
      expect(within(dialog).getByRole('button', {
        name: /save campaign frame\. 8 saves/i,
      })).toHaveAttribute('aria-pressed', 'false');
    });
  });

  it('renders text posts as compact note previews instead of missing media', () => {
    const items: ShowcaseFeedItem[] = [
      {
        id: 'tip-1',
        mediaUrl: null,
        mediaKind: null,
        model: 'manual',
        title: 'Prompt pacing tip',
        prompt: '',
        body: 'Lead with the product benefit before adding cinematic style words.',
        category: 'text',
        postFormat: 'text',
        saveCount: 2,
        remixCount: 1,
        createdAt: '2026-04-25T10:00:00.000Z',
        creator: {
          id: 'creator-1',
          username: 'creator-name',
          name: 'Creator Name',
          avatar: null,
        },
        isSaved: false,
        sourceKind: 'manual',
        sourceTool: null,
        generationId: null,
        asset: {
          id: 'bundle-1',
          postId: 'tip-1',
          title: 'Prompt pacing unlock',
          accessMode: 'free',
          priceUsdCents: 0,
          previewText: 'Prompt included.',
          allowRemix: false,
          resourceKinds: ['prompt'],
        },
        canRemix: false,
      },
    ];

    render(<HomeShowcasePreviewGrid items={items} />);

    expect(screen.getByText('Tip / note')).toBeInTheDocument();
    expect(screen.getByText('Prompt pacing tip')).toBeInTheDocument();
    expect(screen.getByText('Lead with the product benefit before adding cinematic style words.')).toBeInTheDocument();
    expect(screen.getByText('Free unlock')).toBeInTheDocument();
    expect(screen.queryByText('No media preview')).not.toBeInTheDocument();
  });
});
