import { render, screen, within } from '@testing-library/react';
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
const recordPostShareEventMock = vi.fn(async (_payload: unknown) => {
  void _payload;
});

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

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: vi.fn(async () => ({
    session: null,
    credits: null,
  })),
}));

vi.mock('@/app/showcase/[id]/ShowcaseDetailActions', () => ({
  default: ({ postId, canRemix }: { postId: string; canRemix: boolean }) => (
    <div data-testid="showcase-detail-actions">{`${postId}:${canRemix}`}</div>
  ),
}));

vi.mock('@/app/showcase/[id]/PostResourceBundlePanel', () => ({
  default: ({ postId }: { postId: string }) => (
    <div data-testid="post-resource-bundle-panel">{postId}</div>
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
      source_kind: 'magicbooklet',
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
      sourceKind: 'magicbooklet',
      sourceTool: null,
      creator: {
        id: 'user-1',
        username: 'creator-name',
        name: 'Creator Name',
        avatar: null,
      },
      resourceBundle: null,
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

  it('keeps media posts in the media frame and preserves public notes', async () => {
    getPublicPostDetailMock.mockResolvedValueOnce({
      id: 'post-1',
      generationId: 'gen-1',
      visibility: 'public',
      mediaUrl: 'https://cdn.example.com/showcase/gen-1.jpg',
      mediaKind: 'image',
      model: 'nano-banana-2',
      title: 'Shared creation',
      description: 'A polished showcase description.',
      prompt: '',
      body: 'Behind-the-scenes context for this frame.',
      category: 'image',
      postFormat: 'mixed',
      saveCount: 12,
      remixCount: 3,
      shareCount: 7,
      shareVisitCount: 18,
      createdAt: '2026-03-28T10:00:00.000Z',
      sourceKind: 'magicbooklet',
      sourceTool: null,
      creator: {
        id: 'user-1',
        username: 'creator-name',
        name: 'Creator Name',
        avatar: null,
      },
      resourceBundle: null,
      canRemix: true,
    });

    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
    }));

    expect(screen.getByTestId('media-detail-frame')).toBeInTheDocument();
    expect(screen.getByTestId('post-body-panel')).toHaveTextContent('Behind-the-scenes context for this frame.');
  });

  it('uses the source return context for the detail back link', async () => {
    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
      searchParams: Promise.resolve({
        from: 'unlocks',
        returnTo: '/marketplace?access=paid&resource=workflow',
      }),
    }));

    expect(screen.getByRole('link', { name: /back to unlocks/i })).toHaveAttribute(
      'href',
      '/marketplace?access=paid&resource=workflow'
    );
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
      source_kind: 'magicbooklet',
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
      resourceBundle: null,
      canRemix: false,
    });

    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-text' }),
    }));

    expect(screen.getByTestId('text-detail-note')).toHaveTextContent('Open with tension.');
    expect(screen.getAllByText(/open with tension/i)).toHaveLength(1);
    expect(screen.queryByTestId('media-detail-frame')).not.toBeInTheDocument();
    expect(screen.queryByTestId('post-body-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('showcase-detail-actions')).toHaveTextContent('post-text:false');
  });

  it('uses the top unlock card as a jump link, not a second unlock action', async () => {
    getPostReferenceForShowcaseIdMock.mockResolvedValueOnce({
      id: 'post-text',
      generation_id: null,
      visibility: 'public',
      category: 'text',
      prompt: null,
      source_kind: 'manual',
    });
    getPublicPostDetailMock.mockResolvedValueOnce({
      id: 'post-text',
      generationId: null,
      visibility: 'public',
      mediaUrl: null,
      mediaKind: null,
      model: 'manual',
      title: 'Prompt tip',
      description: '',
      prompt: '',
      body: 'Use fewer modifiers.',
      category: 'text',
      postFormat: 'text',
      saveCount: 0,
      remixCount: 0,
      shareCount: 0,
      shareVisitCount: 0,
      createdAt: '2026-03-28T10:00:00.000Z',
      sourceKind: 'manual',
      sourceTool: null,
      creator: {
        id: 'user-1',
        username: 'creator-name',
        name: 'Creator Name',
        avatar: null,
      },
      resourceBundle: {
        id: 'bundle-1',
        accessMode: 'free',
        priceQuote: {
          formatted: '$0.00',
          note: null,
        },
        resourceKinds: ['prompt'],
        lockedPreview: {
          resourceKinds: ['prompt'],
          attachmentPreviews: [],
          itemCounts: { prompt: 1 },
          itemPreviews: [{
            type: 'prompt',
            title: 'Prompt',
            role: 'primary',
            remixUse: 'none',
          }],
          hasPrompt: true,
          hasNotes: false,
          hasWorkflow: false,
          hasRemix: false,
          updatedAt: '2026-03-28T10:00:00.000Z',
        },
        viewerCanAccess: false,
        viewerIsOwner: false,
        salesCount: 0,
        resources: null,
        title: 'Prompt tip',
        summary: '',
        previewText: '',
        priceUsdCents: 0,
        status: 'published',
      },
      canRemix: false,
    });

    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-text' }),
    }));

    const unlockSummary = screen.getByTestId('unlock-summary-link');
    expect(within(unlockSummary).getByText(/free unlock available/i)).toBeInTheDocument();
    expect(within(unlockSummary).getByText(/open free unlock/i)).toBeInTheDocument();
    expect(within(unlockSummary).queryByText(/view unlock details/i)).not.toBeInTheDocument();
  });
});
