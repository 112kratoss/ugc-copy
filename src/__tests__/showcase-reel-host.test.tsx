import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ShowcaseReelViewerProps } from '@/app/showcase/ShowcaseReelViewer';
import { holdTilePicture, loadedTilePicture, releaseTilePicture } from '@/app/showcase/tile-pictures';

// The reel's module, standing in: it says which post it shows.
vi.mock('@/app/showcase/ShowcaseReelViewer', () => ({
  default: ({ selectedItemId }: { selectedItemId: string | null }) => (
    <div role="dialog" aria-label="Explore reel viewer">{selectedItemId}</div>
  ),
}));

const props = {
  isOpen: true,
  items: [],
  selectedItemId: 'post-1',
  savedItemIds: new Set<string>(),
  hasMoreItems: false,
  isLoadingMoreItems: false,
  onLoadMoreItems: () => {},
  onClose: () => {},
  onSelectItemId: () => {},
  onToggleSave: () => {},
  onRemix: () => {},
  buildDetailPath: (id: string) => `/showcase/${id}`,
} satisfies ShowcaseReelViewerProps;

/** The host and its loader as a page first meets them: nothing loaded, nothing drawn yet. */
async function freshReelHost() {
  vi.resetModules();
  const [{ default: ShowcaseReel }, { loadShowcaseReelViewer }] = await Promise.all([
    import('@/app/showcase/ShowcaseReel'),
    import('@/app/showcase/showcase-reel-loader'),
  ]);
  return { ShowcaseReel, loadShowcaseReelViewer };
}

// Owner's recording, 2026-11-16: a tap on an Explore tile drew the grid dimmed under "Opening
// preview" before the reel, though the reel's code had been loaded ahead. Through `next/dynamic` a
// page's first open always waited in a Suspense boundary, and React shows a boundary's fallback
// for 300 ms at least (tests/e2e/explore-reel-open.spec.ts draws the tap).
describe('ShowcaseReel', () => {
  it("draws a page's first reel in the render that opens it once the reel's code is in the document", async () => {
    const { ShowcaseReel, loadShowcaseReelViewer } = await freshReelHost();
    await loadShowcaseReelViewer();

    // The first commit holds the reel: no fallback before it.
    render(<ShowcaseReel {...props} />);

    expect(screen.getByRole('dialog', { name: 'Explore reel viewer' })).toHaveTextContent('post-1');
    expect(screen.queryByText('Opening preview')).toBeNull();
  });

  it('draws "Opening preview" while the reel\'s code is still on its way, then the reel', async () => {
    const { ShowcaseReel } = await freshReelHost();

    render(<ShowcaseReel {...props} selectedItemId="post-2" />);

    expect(screen.getByRole('status')).toHaveTextContent('Opening preview');
    expect(await screen.findByRole('dialog', { name: 'Explore reel viewer' })).toHaveTextContent('post-2');
    expect(screen.queryByText('Opening preview')).toBeNull();
  });
});

describe('tile pictures', () => {
  function loadedImage(): HTMLImageElement {
    const image = document.createElement('img');
    Object.defineProperty(image, 'complete', { value: true });
    Object.defineProperty(image, 'naturalWidth', { value: 720 });
    return image;
  }

  it('gives the reel the picture a tile holds, once it has loaded', () => {
    const image = loadedImage();
    holdTilePicture('media-1', image);
    expect(loadedTilePicture('media-1')).toBe(image);

    const loading = document.createElement('img');
    holdTilePicture('media-2', loading);
    expect(loadedTilePicture('media-2')).toBeNull();
    expect(loadedTilePicture(null)).toBeNull();
  });

  it('forgets a picture its tile no longer draws, and only that one', () => {
    const first = loadedImage();
    const second = loadedImage();
    holdTilePicture('media-3', first);
    holdTilePicture('media-3', second);

    // The tile that drew the first unmounts after the second took its place.
    releaseTilePicture('media-3', first);
    expect(loadedTilePicture('media-3')).toBe(second);

    releaseTilePicture('media-3', second);
    expect(loadedTilePicture('media-3')).toBeNull();
  });
});
