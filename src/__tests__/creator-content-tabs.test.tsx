import type { HTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CreatorContentTabs } from '@/app/creators/[username]/CreatorContentTabs';
import type { CreatorProfilePageData } from '@/lib/creator-profile';

vi.mock('next/navigation', () => ({
  usePathname: () => '/creators/creator-name',
}));

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
      mediaUrl: 'https://example.com/creation.jpg',
      mediaKind: 'image',
      model: 'nano-banana-2',
      title: 'Campaign Frame',
      prompt: 'A creator holds the product near a bright window.',
      body: '',
      category: 'image',
      postFormat: 'media',
      saveCount: 12,
      remixCount: 4,
      createdAt: '2026-03-27T10:00:00.000Z',
      creator: {
        id: 'creator-1',
        username: 'creator-name',
        name: 'Creator Name',
        avatar: null,
      },
      sourceKind: 'magicbooklet',
      sourceTool: null,
      generationId: 'gen-1',
      asset: null,
      canRemix: true,
    },
    {
      id: 'item-2',
      mediaUrl: null,
      mediaKind: null,
      model: 'external',
      title: 'Workflow Breakdown',
      prompt: '',
      body: '',
      category: 'text',
      postFormat: 'text',
      saveCount: 3,
      remixCount: 1,
      createdAt: '2026-03-28T10:00:00.000Z',
      creator: {
        id: 'creator-1',
        username: 'creator-name',
        name: 'Creator Name',
        avatar: null,
      },
      sourceKind: 'external',
      sourceTool: 'Runway',
      sourceToolSlug: 'runway',
      generationId: null,
      asset: {
        id: 'bundle-1',
        postId: 'item-2',
        title: 'Workflow Breakdown Unlock',
        accessMode: 'paid',
        priceUsdCents: 900,
        previewText: 'Prompt and workflow included.',
        allowRemix: false,
        salesCount: 2,
        resourceKinds: ['prompt', 'workflow'],
      },
      canRemix: false,
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

  it('uses portfolio collection language and metadata fallbacks', () => {
    render(<CreatorContentTabs items={items} tools={[{ slug: 'runway', label: 'Runway', count: 1 }]} />);

    expect(screen.getByRole('button', { name: /collection\s*2/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^posts/i })).not.toBeInTheDocument();
    expect(screen.getByText('Tip / note')).toBeInTheDocument();
    expect(screen.getAllByText(/made with runway/i)[0]).toBeInTheDocument();
    expect(screen.getByText('$9.00 unlock')).toBeInTheDocument();
    expect(screen.getByText('Prompt')).toBeInTheDocument();
    expect(screen.getByText('Workflow')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /unlocks\s*1/i }));

    expect(screen.getByRole('heading', { name: 'Unlocks' })).toBeInTheDocument();
    expect(screen.getByText(/reusable prompts, workflows, files/i)).toBeInTheDocument();
    expect(screen.getByText('Workflow Breakdown')).toBeInTheDocument();
  });
});
