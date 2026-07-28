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
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock('next/dynamic', () => ({
  default: () => function MockShowcaseReelViewer({
    isOpen,
    items,
    selectedItemId,
    savedItemIds,
    savingItemIds,
    onToggleSave,
    onRemix,
    buildDetailPath,
  }: {
    isOpen: boolean;
    items: ShowcaseFeedItem[];
    selectedItemId: string | null;
    savedItemIds: Set<string>;
    savingItemIds: Set<string>;
    onToggleSave: (id: string) => void;
    onRemix: (id: string) => void;
    buildDetailPath: (id: string, section?: string) => string;
  }) {
    const selectedItem = items.find((item) => item.id === selectedItemId);
    if (!isOpen || !selectedItem) return null;

    return (
      <div role="dialog" aria-label={`${selectedItem.title} Showcase reel`}>
        <h2>{selectedItem.title}</h2>
        <p>{selectedItem.body || selectedItem.prompt}</p>
        {selectedItem.mediaKind === 'video' ? (
          <video src={selectedItem.mediaUrl ?? undefined} />
        ) : selectedItem.mediaUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={selectedItem.mediaUrl} alt={selectedItem.title} />
        ) : null}
        <button type="button" aria-label="Share">Share</button>
        <button
          type="button"
          onClick={() => onToggleSave(selectedItem.id)}
          disabled={savingItemIds.has(selectedItem.id)}
          aria-label={`${savedItemIds.has(selectedItem.id) ? 'Remove save from' : 'Save'} ${selectedItem.title}. ${selectedItem.saveCount} saves`}
          aria-pressed={savedItemIds.has(selectedItem.id)}
        >
          Save
        </button>
        {selectedItem.canRemix ? (
          <button
            type="button"
            onClick={() => onRemix(selectedItem.id)}
            aria-label={`Remix ${selectedItem.title}. ${selectedItem.remixCount} remixes`}
          >
            Remix
          </button>
        ) : null}
        <a href={buildDetailPath(selectedItem.id)}>Post details</a>
        {selectedItem.asset ? <a href={buildDetailPath(selectedItem.id, 'resources')}>View recipe</a> : null}
      </div>
    );
  },
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
  HoverVideo: ({ src, poster, className }: { src: string; poster?: string | null; className?: string }) => (
    <video data-testid="hover-video" data-original-src={src} poster={poster ?? undefined} className={className} />
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
    commentCount: 0,
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
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens the shared Showcase reel from the homepage grid with post actions', () => {
    const items: ShowcaseFeedItem[] = [createShowcaseItem()];

    render(<HomeShowcasePreviewGrid items={items} />);

    fireEvent.click(screen.getByRole('button', { name: /preview campaign frame/i }));

    const dialog = screen.getByRole('dialog', { name: /campaign frame/i });
    expect(within(dialog).getByText('A creator-style product shot by a bright window.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^share$/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /8 saves/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /3 remixes/i })).toBeInTheDocument();

    const openPageLink = within(dialog).getByRole('link', { name: /post details/i });
    expect(openPageLink).toHaveAttribute('href', '/showcase/gen-1?from=home&returnTo=%2F');
    expect(window.location.search).toBe('?post=gen-1');
  });

  it('optimistically saves and unsaves from the homepage reel with accessible state', async () => {
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

  it('restores the homepage reel save state when saving fails', async () => {
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

  it('leaves text-only posts to the feed instead of faking a media tile', () => {
    const items: ShowcaseFeedItem[] = [
      createShowcaseItem(),
      {
        ...createShowcaseItem({ title: 'Prompt pacing tip' }),
        id: 'tip-1',
        mediaUrl: null,
        mediaKind: null,
        mediaItems: undefined,
        prompt: '',
        body: 'Lead with the product benefit before adding cinematic style words.',
        category: 'text',
        postFormat: 'text',
        generationId: null,
      },
    ];

    render(<HomeShowcasePreviewGrid items={items} />);

    expect(screen.getByRole('button', { name: /preview campaign frame/i })).toBeInTheDocument();
    expect(screen.queryByText('Prompt pacing tip')).not.toBeInTheDocument();
    expect(screen.queryByText('Tip / note')).not.toBeInTheDocument();
    expect(screen.queryByText('No media preview')).not.toBeInTheDocument();
  });

  it('lazy-loads media images in the homepage inspiration grid', () => {
    render(<HomeShowcasePreviewGrid items={[createShowcaseItem()]} />);

    const image = screen.getByRole('img', { name: 'Campaign Frame' });
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('decoding', 'async');
  });

  it('renders existing preview media in cards while retaining the original for detail', () => {
    render(<HomeShowcasePreviewGrid items={[createShowcaseItem({
      mediaUrl: 'https://example.com/original.jpg',
      mediaItems: [{
        id: 'media-1',
        url: 'https://example.com/original.jpg',
        previewUrl: 'https://example.com/preview.webp',
        mediaKind: 'image',
        contentType: 'image/jpeg',
        originalName: 'original.jpg',
        width: 1080,
        height: 1350,
        durationSeconds: null,
        sortOrder: 0,
      }],
    })]} />);

    expect(screen.getByRole('img', { name: 'Campaign Frame' }))
      .toHaveAttribute('src', 'https://example.com/preview.webp');

    fireEvent.click(screen.getByRole('button', { name: /preview campaign frame/i }));
    expect(within(screen.getByRole('dialog')).getByRole('img', { name: 'Campaign Frame' }))
      .toHaveAttribute('src', 'https://example.com/original.jpg');
  });

  it('uses the preview as a video poster without replacing the detail source', () => {
    render(<HomeShowcasePreviewGrid items={[createShowcaseItem({
      mediaUrl: 'https://example.com/original.mp4',
      mediaKind: 'video',
      category: 'video',
      mediaItems: [{
        id: 'media-1',
        url: 'https://example.com/original.mp4',
        previewUrl: 'https://example.com/preview.webp',
        mediaKind: 'video',
        contentType: 'video/mp4',
        originalName: 'original.mp4',
        width: 1080,
        height: 1350,
        durationSeconds: 8,
        sortOrder: 0,
      }],
    })]} />);

    const previewVideo = screen.getByTestId('hover-video');
    expect(previewVideo).toHaveAttribute('poster', 'https://example.com/preview.webp');
    expect(previewVideo).toHaveAttribute('data-original-src', 'https://example.com/original.mp4');
    expect(previewVideo).not.toHaveAttribute('src');

    fireEvent.click(screen.getByRole('button', { name: /preview campaign frame/i }));
    expect(screen.getByRole('dialog').querySelector('video'))
      .toHaveAttribute('src', 'https://example.com/original.mp4');
  });
});
