import type { HTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

describe('HomeShowcasePreviewGrid', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the media preview modal from the homepage inspiration grid with action buttons', () => {
    const items: ShowcaseFeedItem[] = [
      {
        id: 'gen-1',
        url: 'https://example.com/image.jpg',
        model: 'nano-banana-2',
        title: 'Campaign Frame',
        prompt: 'A creator-style product shot by a bright window.',
        category: 'image',
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
      },
    ];

    render(<HomeShowcasePreviewGrid items={items} />);

    fireEvent.click(screen.getByRole('button', { name: /preview campaign frame/i }));

    const dialog = screen.getByRole('dialog', { name: /campaign frame/i });
    expect(within(dialog).getByText('A creator-style product shot by a bright window.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^share$/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /8 saves/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /3 remixes/i })).toBeInTheDocument();

    const openPageLink = within(dialog).getByRole('link', { name: /open public page/i });
    expect(openPageLink).toHaveAttribute('href', '/showcase/gen-1');
  });
});
