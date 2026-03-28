import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseDetailPage, { generateMetadata } from '@/app/showcase/[id]/page';

const mockHeaders = vi.fn(async () => new Headers());
const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
const getPublicGenerationDetailMock = vi.fn();
const recordGenerationShareEventMock = vi.fn(async () => undefined);

vi.mock('next/headers', () => ({
  headers: () => mockHeaders(),
}));

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
}));

vi.mock('@/lib/public-generations', () => ({
  getPublicGenerationDetail: (id: string) => getPublicGenerationDetailMock(id),
}));

vi.mock('@/lib/generation-share-events', () => ({
  recordGenerationShareEvent: (payload: unknown) => recordGenerationShareEventMock(payload),
}));

vi.mock('@/app/showcase/[id]/ShowcaseDetailActions', () => ({
  default: ({ generationId }: { generationId: string }) => <div data-testid="showcase-detail-actions">{generationId}</div>,
}));

describe('Showcase detail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPublicGenerationDetailMock.mockResolvedValue({
      id: 'gen-1',
      url: 'https://cdn.example.com/showcase/gen-1.jpg',
      model: 'nano-banana-2',
      title: 'Shared creation',
      description: 'A polished showcase description.',
      prompt: 'A creator holds the product by a bright window.',
      category: 'image',
      saveCount: 12,
      remixCount: 3,
      shareCount: 7,
      shareVisitCount: 18,
      createdAt: '2026-03-28T10:00:00.000Z',
      creator: {
        id: 'user-1',
        username: 'creator-name',
        name: 'Creator Name',
        avatar: null,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a public creation and records a share visit', async () => {
    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'gen-1' }),
    }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    expect(screen.getByText('A polished showcase description.')).toBeInTheDocument();
    expect(screen.getByText('A creator holds the product by a bright window.')).toBeInTheDocument();
    expect(screen.getByTestId('showcase-detail-actions')).toHaveTextContent('gen-1');
    expect(recordGenerationShareEventMock).toHaveBeenCalledWith({
      generationId: 'gen-1',
      eventType: 'share_visit',
      sourceSurface: 'detail-page',
    });
  });

  it('generates canonical metadata for the public detail page', async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ id: 'gen-1' }),
    });

    expect(metadata.alternates?.canonical).toBe('/showcase/gen-1');
    expect(metadata.openGraph?.images?.[0]).toMatchObject({
      url: 'https://cdn.example.com/showcase/gen-1.jpg',
    });
  });

  it('returns notFound for private or missing creations', async () => {
    getPublicGenerationDetailMock.mockResolvedValueOnce(null);

    await expect(ShowcaseDetailPage({
      params: Promise.resolve({ id: 'missing' }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
