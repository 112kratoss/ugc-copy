import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import RecipeMediaGallery from '@/app/showcase/[id]/RecipeMediaGallery';
import { normalizePostResourceItems } from '@/lib/post-resource-bundles';

/**
 * A recipe's pictures and clips as a gallery (recipe reading review,
 * 2026-10-29): its own full-screen view, drawn over the page or inside the
 * reel's dialog, on the signed links themselves, and the reel under it does
 * not page posts on the view's keys, wheel or swipes.
 */
const items = normalizePostResourceItems([
  { type: 'reference_image', title: '@ali', description: 'The first person', storagePath: 'u/ali.png', contentType: 'image/png' },
  { type: 'reference_video', title: 'Video reference 1', storagePath: 'u/clip.mp4', contentType: 'video/mp4' },
  { type: 'reference_audio', title: 'Voice', storagePath: 'u/voice.mp3', contentType: 'audio/mpeg' },
]);

function renderGallery(wrapper?: (gallery: React.ReactNode) => React.ReactNode, galleryItems = items) {
  const signUrl = vi.fn(async (storagePath: string) => `https://signed.example.com/${storagePath}`);
  const onDownload = vi.fn();
  const gallery = <RecipeMediaGallery items={galleryItems} title="References" signUrl={signUrl} onDownload={onDownload} />;
  return { ...render(<>{wrapper ? wrapper(gallery) : gallery}</>), signUrl, onDownload };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RecipeMediaGallery', () => {
  it('names every tile, draws a clip by its first frame, and plays a sound in place', async () => {
    const { container, onDownload } = renderGallery();

    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'https://signed.example.com/u/ali.png'));
    expect(container.querySelector('video')).toHaveAttribute('src', 'https://signed.example.com/u/clip.mp4#t=0.1');
    expect(screen.getAllByRole('listitem').map((tile) => within(tile).getByTitle(/./).textContent)).toEqual(['@ali', 'Video reference 1', 'Voice']);
    // The creator's line under a reference, as the app shows it.
    expect(screen.getByText('The first person')).toBeInTheDocument();
    expect(container.querySelector('audio')).toHaveAttribute('src', 'https://signed.example.com/u/voice.mp3');
    expect(container.querySelector('audio')).toHaveAttribute('aria-label', 'Play Voice');

    fireEvent.click(screen.getByRole('button', { name: 'Download @ali' }));
    expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ storagePath: 'u/ali.png' }));
  });

  it('draws the full-screen view over the page on the signed link itself, never the image optimizer', async () => {
    renderGallery((gallery) => <section data-testid="column">{gallery}</section>);

    await waitFor(() => expect(screen.getByRole('button', { name: 'View @ali' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'View @ali' }));

    const view = await screen.findByRole('dialog', { name: 'References' });
    expect(within(screen.getByTestId('column')).queryByRole('dialog')).toBeNull();
    expect(view.parentElement?.parentElement).toBe(document.body);
    // The paid file is drawn from the link signed for ten minutes, not through /_next/image.
    expect(view.querySelector('img')).toHaveAttribute('src', 'https://signed.example.com/u/ali.png');
    expect(within(view).getByText('· 1 of 2')).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.click(within(view).getByRole('button', { name: 'Next' }));
    expect(view.querySelector('video')).toHaveAttribute('src', 'https://signed.example.com/u/clip.mp4');

    fireEvent.keyDown(view, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.style.overflow).toBe('');
  });

  it('draws the view inside the reel it sits in, and keeps the reel from paging under it', async () => {
    const onReelWheel = vi.fn();
    const onReelKey = vi.fn();
    window.addEventListener('keydown', onReelKey);
    try {
      renderGallery((gallery) => (
        <div role="dialog" aria-label="Explore reel viewer" onWheel={onReelWheel}>
          <div data-reel-scroll-region="details">{gallery}</div>
        </div>
      ), items.slice(0, 1));

      await waitFor(() => expect(screen.getByRole('button', { name: 'View @ali' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'View @ali' }));

      const view = await screen.findByRole('dialog', { name: 'References' });
      expect(screen.getByRole('dialog', { name: 'Explore reel viewer' }).contains(view)).toBe(true);
      // The reel holds the page's scroll; the view leaves it to the reel.
      expect(document.body.style.overflow).toBe('');

      fireEvent.wheel(view, { deltaY: 120 });
      expect(onReelWheel).not.toHaveBeenCalled();

      // One picture: no Next to take the arrow, and the reel still must not page.
      for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp']) {
        fireEvent.keyDown(view, { key });
      }
      expect(onReelKey).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Close media' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'References' })).toBeNull());
      fireEvent.keyDown(document.body, { key: 'ArrowDown' });
      expect(onReelKey).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', onReelKey);
    }
  });

  it('signs nothing and shows no picture under a mature cover, and keeps the names and downloads', async () => {
    const signUrl = vi.fn(async (storagePath: string) => `https://signed.example.com/${storagePath}`);
    const props = { items, title: 'References', signUrl, onDownload: vi.fn() };
    const { container, rerender } = render(<RecipeMediaGallery {...props} coverPlate={<p>Mature content</p>} />);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signUrl).not.toHaveBeenCalled();
    expect(container.querySelector('img, video, audio')).toBeNull();
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
    const { container } = render(<RecipeMediaGallery items={items} title="References" signUrl={signUrl} onDownload={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reload' }));

    await waitFor(() => expect(container.querySelector('img')).toHaveAttribute('src', 'https://signed.example.com/u/ali.png'));
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });

  // ResourceMediaPreview, which the gallery replaced, gave up after 30 s; a
  // request that never answers no longer leaves a spinner for good.
  it('offers a reload once a link has not come in 30 seconds', async () => {
    vi.useFakeTimers();
    const signUrl = vi.fn(() => new Promise<string>(() => undefined));
    render(<RecipeMediaGallery items={items.slice(0, 1)} title="References" signUrl={signUrl} onDownload={vi.fn()} />);

    expect(screen.getByRole('status', { name: 'Loading @ali' })).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });
});
