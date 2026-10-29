import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import RecipeMediaGallery from '@/app/showcase/[id]/RecipeMediaGallery';
import { normalizePostResourceItems } from '@/lib/post-resource-bundles';

/**
 * A recipe's pictures and clips as a gallery (recipe reading review,
 * 2026-10-29): the full-screen view is drawn over the page, or inside the
 * reel's dialog when the gallery sits in the reel, and the reel under it does
 * not page posts on the view's wheel, swipe or arrow keys.
 */
const items = normalizePostResourceItems([
  { type: 'reference_image', title: '@ali', storagePath: 'u/ali.png', contentType: 'image/png' },
  { type: 'reference_video', title: 'Video reference 1', storagePath: 'u/clip.mp4', contentType: 'video/mp4' },
  { type: 'reference_audio', title: 'Voice', storagePath: 'u/voice.mp3', contentType: 'audio/mpeg' },
]);

function renderGallery(wrapper?: (gallery: React.ReactNode) => React.ReactNode) {
  const signUrl = vi.fn(async (storagePath: string) => `https://signed.example.com/${storagePath}`);
  const onDownload = vi.fn();
  const onOpenFile = vi.fn();
  const gallery = (
    <RecipeMediaGallery items={items} title="References" signUrl={signUrl} onDownload={onDownload} onOpenFile={onOpenFile} />
  );
  return { ...render(<>{wrapper ? wrapper(gallery) : gallery}</>), signUrl, onDownload, onOpenFile };
}

describe('RecipeMediaGallery', () => {
  it('names every tile, draws a clip by its first frame, and plays a sound in the browser', async () => {
    const { container, onDownload, onOpenFile } = renderGallery();

    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'https://signed.example.com/u/ali.png'));
    expect(container.querySelector('video')).toHaveAttribute('src', 'https://signed.example.com/u/clip.mp4#t=0.1');
    expect(screen.getAllByRole('listitem').map((tile) => within(tile).getByTitle(/./).textContent)).toEqual(['@ali', 'Video reference 1', 'Voice']);

    fireEvent.click(screen.getByRole('button', { name: 'Play Voice' }));
    expect(onOpenFile).toHaveBeenCalledWith('u/voice.mp3');
    fireEvent.click(screen.getByRole('button', { name: 'Download @ali' }));
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ storagePath: 'u/ali.png' }));
  });

  it('draws the full-screen view over the page, outside the column it sits in', async () => {
    renderGallery((gallery) => <section data-testid="column">{gallery}</section>);

    await waitFor(() => expect(screen.getByRole('button', { name: 'View @ali' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'View @ali' }));

    const view = await screen.findByRole('dialog', { name: 'References' });
    expect(within(screen.getByTestId('column')).queryByRole('dialog')).toBeNull();
    expect(view.parentElement?.parentElement?.parentElement).toBe(document.body);
  });

  it('draws the view inside the reel it sits in, and keeps the reel from paging under it', async () => {
    const onReelWheel = vi.fn();
    const onReelKey = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    window.addEventListener('keydown', onReelKey);
    try {
      renderGallery((gallery) => (
        <div role="dialog" aria-label="Explore reel viewer" onWheel={onReelWheel}>
          <div data-reel-scroll-region="details">{gallery}</div>
        </div>
      ));

      await waitFor(() => expect(screen.getByRole('button', { name: 'View @ali' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'View @ali' }));

      const view = await screen.findByRole('dialog', { name: 'References' });
      expect(screen.getByRole('dialog', { name: 'Explore reel viewer' }).contains(view)).toBe(true);

      fireEvent.wheel(view, { deltaY: 120 });
      expect(onReelWheel).not.toHaveBeenCalled();

      fireEvent.keyDown(view, { key: 'ArrowDown' });
      // The reel reads a key it should leave alone as one already answered.
      expect(onReelKey).toHaveLastReturnedWith(true);

      fireEvent.click(screen.getByRole('button', { name: 'Close media' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'References' })).toBeNull());
      fireEvent.keyDown(document.body, { key: 'ArrowDown' });
      expect(onReelKey).toHaveLastReturnedWith(false);
    } finally {
      window.removeEventListener('keydown', onReelKey);
    }
  });

  it('signs nothing and shows no picture under a mature cover, and keeps the names and downloads', async () => {
    const signUrl = vi.fn(async (storagePath: string) => `https://signed.example.com/${storagePath}`);
    const props = { items, title: 'References', signUrl, onDownload: vi.fn(), onOpenFile: vi.fn() };
    const { container, rerender } = render(<RecipeMediaGallery {...props} coverPlate={<p>Mature content</p>} />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signUrl).not.toHaveBeenCalled();
    expect(container.querySelector('img, video')).toBeNull();
    expect(screen.getByText('Mature content')).toBeInTheDocument();
    expect(screen.getByText('@ali')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Download / })).toHaveLength(3);

    // The panel's one Show takes the plate away: the links are asked for then.
    rerender(<RecipeMediaGallery {...props} />);
    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'https://signed.example.com/u/ali.png'));
    expect(signUrl).toHaveBeenCalledTimes(3);
  });

  it('offers a reload for a picture that could not be signed', async () => {
    const signUrl = vi.fn(async (storagePath: string) => {
      if (storagePath === 'u/ali.png' && signUrl.mock.calls.filter(([path]) => path === 'u/ali.png').length === 1) {
        throw new Error('Resource unavailable');
      }
      return `https://signed.example.com/${storagePath}`;
    });
    const { container } = render(
      <RecipeMediaGallery items={items} title="References" signUrl={signUrl} onDownload={vi.fn()} onOpenFile={vi.fn()} />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Reload' }));

    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'https://signed.example.com/u/ali.png'));
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });
});
