import { useState, type HTMLAttributes, type ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MediaDetailsPreviewModal from '@/components/MediaDetailsPreviewModal';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

describe('MediaDetailsPreviewModal', () => {
  const writeTextMock = vi.fn();

  beforeEach(() => {
    writeTextMock.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders an image preview with prompt text and copy feedback', async () => {
    writeTextMock.mockResolvedValue(undefined);

    const { container } = render(
      <MediaDetailsPreviewModal
        isOpen
        onClose={() => undefined}
        mediaType="image"
        src="https://example.com/image.jpg"
        alt="Preview image"
        title="Prompted still"
        prompt="Detailed creator prompt"
      />
    );

    const dialog = await screen.findByRole('dialog', { name: /prompted still/i });

    expect(container).not.toContainElement(dialog);
    expect(dialog).toHaveClass('overflow-y-auto');
    expect(screen.getByAltText('Preview image')).toBeInTheDocument();
    expect(screen.getByText('Detailed creator prompt')).toHaveClass('whitespace-pre-wrap');

    fireEvent.click(screen.getByRole('button', { name: /copy prompt/i }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('Detailed creator prompt');
    });
    expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
  });

  it('renders video and audio media types', async () => {
    const { container, rerender } = render(
      <MediaDetailsPreviewModal
        isOpen
        onClose={() => undefined}
        mediaType="video"
        src="https://example.com/video.mp4"
        alt="Preview video"
        title="Video preview"
        prompt="Video prompt"
      />
    );

    await screen.findByRole('dialog', { name: /video preview/i });
    expect(document.querySelector('video')).toBeInTheDocument();

    rerender(
      <MediaDetailsPreviewModal
        isOpen
        onClose={() => undefined}
        mediaType="audio"
        src="https://example.com/audio.mp3"
        alt="Preview audio"
        title="Audio preview"
        prompt="Audio prompt"
      />
    );

    expect(container.querySelector('audio')).toBeNull();
    expect(await screen.findByRole('dialog', { name: /audio preview/i })).toBeInTheDocument();
    expect(document.querySelector('audio')).toBeInTheDocument();
  });

  it('hides the copy button when no prompt is available', async () => {
    render(
      <MediaDetailsPreviewModal
        isOpen
        onClose={() => undefined}
        mediaType="image"
        src="https://example.com/image.jpg"
        alt="Promptless image"
        title="Promptless preview"
        prompt=""
      />
    );

    expect(await screen.findByText('No prompt available')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy prompt/i })).toBeNull();
  });

  it('renders input media previews with labels and opens them in the full media preview', async () => {
    render(
      <MediaDetailsPreviewModal
        isOpen
        onClose={() => undefined}
        mediaType="image"
        src="https://example.com/output.jpg"
        alt="Output"
        title="Input-backed preview"
        prompt="Prompt"
        inputMedia={[
          {
            id: 'input-image-1',
            generationId: 'gen-1',
            mediaType: 'image',
            role: 'reference_image',
            label: 'Hero product',
            url: 'https://example.com/hero.png',
            storagePath: 'generation_inputs/user-1/gen-1/hero.png',
            sourceGenerationId: null,
            sortOrder: 0,
            metadata: {},
          },
          {
            id: 'input-audio-1',
            generationId: 'gen-1',
            mediaType: 'audio',
            role: 'reference_audio',
            label: 'Voice timing',
            url: 'https://example.com/audio.mp3',
            storagePath: 'generation_inputs/user-1/gen-1/audio.mp3',
            sourceGenerationId: null,
            sortOrder: 1,
            metadata: {},
          },
        ]}
      />
    );

    expect(await screen.findByText('Inputs used')).toBeInTheDocument();
    expect(screen.getByAltText('Hero product')).toBeInTheDocument();
    expect(screen.getByText('Voice timing')).toBeInTheDocument();

    expect(document.querySelectorAll('audio')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /voice timing/i }));

    expect(document.querySelectorAll('audio')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /close full media preview/i })).toBeInTheDocument();
  });

  it('opens the main image in a full media preview', async () => {
    render(
      <MediaDetailsPreviewModal
        isOpen
        onClose={() => undefined}
        mediaType="image"
        src="https://example.com/image.jpg"
        alt="Preview image"
        title="Prompted still"
        prompt="Detailed creator prompt"
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /open full image preview/i }));

    expect(screen.getByRole('button', { name: /close full media preview/i })).toBeInTheDocument();
    expect(screen.getAllByAltText('Preview image')).toHaveLength(2);
  });

  it('shows additional outputs and opens them in the full media preview', async () => {
    render(
      <MediaDetailsPreviewModal
        isOpen
        onClose={() => undefined}
        mediaType="image"
        src="https://example.com/primary.jpg"
        alt="Primary output"
        title="Multi-output preview"
        prompt="Prompt"
        additionalMedia={[
          {
            id: 'output-2',
            mediaType: 'image',
            title: 'Output 2',
            alt: 'Additional output 2',
            src: 'https://example.com/secondary.jpg',
          },
        ]}
      />
    );

    expect(await screen.findByText('Additional outputs')).toBeInTheDocument();
    expect(screen.getByAltText('Additional output 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /output 2/i }));

    expect(screen.getByRole('button', { name: /close full media preview/i })).toBeInTheDocument();
    expect(screen.getAllByAltText('Additional output 2')).toHaveLength(2);
  });

  // A failed run's alert opens Studio on that run, which has no media; the
  // modal used to render nothing at all for it.
  it('explains a run with nothing to play in place of the media', async () => {
    render(
      <MediaDetailsPreviewModal
        isOpen
        onClose={() => undefined}
        mediaType="video"
        src={null}
        alt="Neon street"
        title="Neon street"
        prompt="A slow push-in on a neon street."
        statusNote={{
          label: 'Failed',
          tone: 'danger',
          message: 'This model would not accept the reference image.',
          detail: '40 credits returned',
        }}
      />
    );

    const dialog = await screen.findByRole('dialog', { name: 'Neon street' });
    expect(within(dialog).getByText('Failed')).toBeInTheDocument();
    expect(within(dialog).getByText('This model would not accept the reference image.')).toBeInTheDocument();
    expect(within(dialog).getByText('40 credits returned')).toBeInTheDocument();
    expect(within(dialog).getByText('A slow push-in on a neon street.')).toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
  });

  it('still renders nothing for a missing source with no note to show', () => {
    render(
      <MediaDetailsPreviewModal
        isOpen
        onClose={() => undefined}
        mediaType="image"
        src={null}
        alt="Nothing"
        title="Nothing"
      />
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // The viewer moved no focus and kept none: the grid under it stayed in the tab order, the
  // tile that opened it kept the focus (Enter pressed it again), and the focus was left on
  // nothing when it closed (archive/web-history-follow-ups-2026-10-23).
  describe('the focus', () => {
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Open Prompted still</button>
          <button type="button">Next tile</button>
          <MediaDetailsPreviewModal
            isOpen={open}
            onClose={() => setOpen(false)}
            mediaType="image"
            src="https://example.com/image.jpg"
            alt="Preview image"
            title="Prompted still"
            prompt="Detailed creator prompt"
            actions={<a href="/post/new">Turn into post</a>}
          />
        </>
      );
    }
    const openFromTile = async () => {
      render(<Opener />);
      const tile = screen.getByRole('button', { name: 'Open Prompted still' });
      tile.focus();
      fireEvent.click(tile);
      const dialog = await screen.findByRole('dialog', { name: /prompted still/i });
      return { tile, dialog };
    };

    it('takes the focus as it opens and hands it back to the tile as it closes', async () => {
      const { tile, dialog } = await openFromTile();
      await waitFor(() => expect(dialog).toHaveFocus());

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(tile).toHaveFocus();
    });

    it('keeps Tab and Shift+Tab inside, also from the page under it', async () => {
      const { dialog } = await openFromTile();
      await waitFor(() => expect(dialog).toHaveFocus());
      const close = within(dialog).getByRole('button', { name: 'Close preview' });
      const copy = within(dialog).getByRole('button', { name: /copy prompt/i });

      fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
      expect(copy).toHaveFocus();
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(close).toHaveFocus();
      fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
      expect(copy).toHaveFocus();

      screen.getByRole('button', { name: 'Next tile' }).focus();
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(close).toHaveFocus();
    });

    // With the saved setup folded away, its Copy prompt is not drawn: Tab from the setup's summary,
    // the last control on screen, went on out of the viewer, and Shift+Tab from Close sent the
    // focus to the hidden button, so it stayed on Close.
    it('goes round only the controls on screen when the saved setup is folded', async () => {
      const { dialog } = await openFromTile();
      await waitFor(() => expect(dialog).toHaveFocus());
      const close = within(dialog).getByRole('button', { name: 'Close preview' });
      const summary = dialog.querySelector('summary') as HTMLElement;
      (summary.parentElement as HTMLDetailsElement).open = false;

      summary.focus();
      fireEvent.keyDown(window, { key: 'Tab' });
      expect(close).toHaveFocus();
      fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
      expect(summary).toHaveFocus();
    });
  });
});
