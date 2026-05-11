import type { HTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MediaDetailsPreviewModal from '@/app/components/MediaDetailsPreviewModal';

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

  it('renders input media previews with labels', async () => {
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
    expect(document.querySelectorAll('audio')).toHaveLength(1);
  });
});
