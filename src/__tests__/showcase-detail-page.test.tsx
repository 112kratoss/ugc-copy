import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseDetailPage, { generateMetadata } from '@/app/showcase/[id]/page';

const mockHeaders = vi.fn(async () => new Headers());
const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
const mockRedirect = vi.fn((target: string) => {
  throw new Error(`NEXT_REDIRECT:${target}`);
});
const getPostReferenceForShowcaseIdMock = vi.fn<(id?: string) => Promise<Record<string, unknown> | null>>();
const getPublicPostDetailMock = vi.fn<(id?: string) => Promise<Record<string, unknown> | null>>();
const recordPostShareEventMock = vi.fn(async (_payload?: unknown) => undefined);

vi.mock('next/headers', () => ({
  headers: () => mockHeaders(),
}));

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
  redirect: (target: string) => mockRedirect(target),
}));

vi.mock('@/lib/public-posts', () => ({
  getPostReferenceForShowcaseId: (id: string) => getPostReferenceForShowcaseIdMock(id),
  getPublicPostDetail: (id: string) => getPublicPostDetailMock(id),
  getPublicPostMetaDescription: (detail: { description?: string; body?: string; prompt?: string; title: string }) =>
    detail.description || detail.body || detail.prompt || detail.title,
}));

vi.mock('@/lib/post-share-events', () => ({
  recordPostShareEvent: (payload: unknown) => recordPostShareEventMock(payload),
}));

vi.mock('@/app/showcase/[id]/ShowcaseDetailActions', () => ({
  default: ({ postId, canRemix }: { postId: string; canRemix: boolean }) => (
    <div data-testid="showcase-detail-actions">{`${postId}:${canRemix}`}</div>
  ),
}));

describe('Showcase detail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPostReferenceForShowcaseIdMock.mockResolvedValue({
      id: 'post-1',
      generation_id: 'gen-1',
      visibility: 'public',
      category: 'image',
      prompt: 'Prompt',
      source_kind: 'ugc_copy',
    });
    getPublicPostDetailMock.mockResolvedValue({
      id: 'post-1',
      generationId: 'gen-1',
      visibility: 'public',
      mediaUrl: 'https://cdn.example.com/showcase/gen-1.jpg',
      mediaKind: 'image',
      model: 'nano-banana-2',
      title: 'Shared creation',
      description: 'A polished showcase description.',
      prompt: 'A creator holds the product by a bright window.',
      body: '',
      category: 'image',
      postFormat: 'media',
      saveCount: 12,
      remixCount: 3,
      shareCount: 7,
      shareVisitCount: 18,
      createdAt: '2026-03-28T10:00:00.000Z',
      sourceKind: 'ugc_copy',
      sourceTool: null,
      creator: {
        id: 'user-1',
        username: 'creator-name',
        name: 'Creator Name',
        avatar: null,
      },
      asset: null,
      canRemix: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a public post and records a share visit', async () => {
    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
    }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    expect(screen.getByText('A polished showcase description.')).toBeInTheDocument();
    expect(screen.getByText('A creator holds the product by a bright window.')).toBeInTheDocument();
    expect(screen.getByTestId('showcase-detail-actions')).toHaveTextContent('post-1:true');
    expect(recordPostShareEventMock).toHaveBeenCalledWith({
      postId: 'post-1',
      eventType: 'share_visit',
      sourceSurface: 'detail-page',
    });
  });

  it('generates canonical metadata for the public detail page', async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ id: 'post-1' }),
    });

    const images = Array.isArray(metadata.openGraph?.images)
      ? metadata.openGraph?.images
      : metadata.openGraph?.images
        ? [metadata.openGraph.images]
        : [];

    expect(metadata.alternates?.canonical).toBe('/showcase/post-1');
    expect(images[0]).toMatchObject({
      url: 'https://cdn.example.com/showcase/gen-1.jpg',
    });
  });

  it('redirects legacy generation ids to their post ids', async () => {
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce({
      id: 'post-1',
      generation_id: 'gen-1',
      visibility: 'public',
      category: 'image',
      prompt: 'Prompt',
      source_kind: 'ugc_copy',
    });

    await expect(ShowcaseDetailPage({
      params: Promise.resolve({ id: 'gen-1' }),
    })).rejects.toThrow('NEXT_REDIRECT:/showcase/post-1');
  });

  it('returns notFound for private or missing posts', async () => {
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce(null);

    await expect(ShowcaseDetailPage({
      params: Promise.resolve({ id: 'missing' }),
    })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('renders text-only posts without a media url', async () => {
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce({
      id: 'post-text',
      generation_id: null,
      visibility: 'public',
      category: 'text',
      prompt: 'Keep it tight.',
      source_kind: 'manual',
    });
    getPublicPostDetailMock.mockResolvedValueOnce({
      id: 'post-text',
      generationId: null,
      visibility: 'public',
      mediaUrl: null,
      mediaKind: null,
      model: 'manual',
      title: 'Three hooks that keep working',
      description: '',
      prompt: 'Keep it tight.',
      body: 'Open with tension.\nMake the first line earn attention.',
      category: 'text',
      postFormat: 'text',
      saveCount: 5,
      remixCount: 0,
      shareCount: 2,
      shareVisitCount: 11,
      createdAt: '2026-03-28T10:00:00.000Z',
      sourceKind: 'manual',
      sourceTool: null,
      creator: {
        id: 'user-1',
        username: 'creator-name',
        name: 'Creator Name',
        avatar: null,
      },
      asset: null,
      canRemix: false,
    });

    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-text' }),
    }));

    expect(screen.getAllByText(/open with tension/i)).toHaveLength(2);
    expect(screen.getByTestId('showcase-detail-actions')).toHaveTextContent('post-text:false');
  });
});
