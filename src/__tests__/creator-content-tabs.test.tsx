import type { HTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreatorContentTabs } from '@/app/creators/[username]/CreatorContentTabs';
import type { CreatorProfilePageData } from '@/lib/creator-profile';

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

describe('CreatorContentTabs', () => {
  const writeTextMock = vi.fn();

  const items: CreatorProfilePageData['items'] = [
    {
      id: 'item-1',
      url: 'https://example.com/creation.jpg',
      model: 'nano-banana-2',
      title: 'Campaign Frame',
      prompt: 'A creator holds the product near a bright window.',
      category: 'image',
      saveCount: 12,
      remixCount: 4,
      createdAt: '2026-03-27T10:00:00.000Z',
      creator: {
        id: 'creator-1',
        username: 'creator-name',
        name: 'Creator Name',
        avatar: null,
      },
    },
  ];

  beforeEach(() => {
    writeTextMock.mockReset();
    writeTextMock.mockResolvedValue(undefined);
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

  it('opens the shared preview modal and copies the prompt from a creation card', async () => {
    render(<CreatorContentTabs items={items} />);

    fireEvent.click(screen.getByRole('button', { name: /campaign frame/i }));

    const dialog = screen.getByRole('dialog', { name: /campaign frame/i });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText('A creator holds the product near a bright window.')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: /copy prompt/i }));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('A creator holds the product near a bright window.');
    });
    expect(within(dialog).getByRole('button', { name: /copied/i })).toBeInTheDocument();
  });
});
