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

const routerBackMock = vi.fn();

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
  redirect: (target: string) => mockRedirect(target),
  // The back affordance is a client component that pops history when the viewer
  // arrived from inside the app.
  useRouter: () => ({ back: routerBackMock, push: vi.fn(), replace: vi.fn() }),
}));

// The page defers its share-visit write with `after`, which throws outside a
// real request scope. Run the work immediately so the assertions below still
// observe it.
vi.mock('next/server', () => ({
  after: (work: unknown) => {
    if (typeof work === 'function') void (work as () => unknown)();
  },
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

vi.mock('@/app/components/PostComments', () => ({
  default: () => <div data-testid="post-comments-component">Comments</div>,
}));

vi.mock('@/app/showcase/[id]/ShowcaseDetailEngagementRow', () => ({
  default: ({ postId, canRemix }: { postId: string; canRemix: boolean }) => (
    <div data-testid="showcase-detail-engagement-row">{`${postId}:${canRemix}`}</div>
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
    expect(screen.getByTestId('canonical-post-comments')).toBeInTheDocument();
    // No bundle on this post — the rail offers no recipe pointer.
    expect(screen.queryByTestId('recipe-jump-link')).not.toBeInTheDocument();
  });

  it('does not count an in-app open as a share visit', async () => {
    // Every in-app link carries `from`; a shared URL never does, because
    // buildShowcaseDetailUrl is called without options. So the presence of that
    // param is the exact test for "did not arrive from outside".
    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
      searchParams: Promise.resolve({ from: 'community', returnTo: '/feed' }),
    }));

    expect(screen.getByRole('heading', { name: /shared creation/i })).toBeInTheDocument();
    expect(recordPostShareEventMock).not.toHaveBeenCalled();
  });

  it('does not mount public-only comments on an unlisted detail page', async () => {
    const detail = await getPublicPostDetailMock('post-1');
    getPublicPostDetailMock.mockResolvedValueOnce({
      ...detail,
      visibility: 'unlisted',
    });

    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
    }));

    expect(screen.queryByTestId('canonical-post-comments')).not.toBeInTheDocument();
    expect(screen.queryByTestId('post-comments-component')).not.toBeInTheDocument();
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
    // The note reads in the document under the media, not in a side panel.
    expect(screen.queryByTestId('post-body-panel')).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('media-detail-document')).getByText('Behind-the-scenes context for this frame.')
    ).toBeInTheDocument();
  });

  it('reads as one document: byline, title, media, then engagement', async () => {
    const { container } = render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
    }));

    const head = screen.getByTestId('canonical-post-head');
    const media = screen.getByTestId('canonical-post-media');
    const actions = screen.getByTestId('canonical-post-actions');
    const heading = screen.getByRole('heading', { level: 1, name: 'Shared creation' });
    const frame = screen.getByTestId('media-detail-frame');
    const engagement = screen.getByTestId('showcase-detail-engagement-row');
    const mediaViewport = container.querySelector('[data-showcase-media-viewport]');

    // No identity side card. The masthead is its own grid row, which is what
    // lets the rail start level with the media instead of the byline.
    expect(screen.queryByTestId('canonical-post-identity')).not.toBeInTheDocument();
    expect(head).toContainElement(heading);
    expect(head).toHaveTextContent('@creator-name');
    expect(media).toContainElement(frame);
    expect(head.compareDocumentPosition(media) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(frame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(frame.compareDocumentPosition(engagement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(media.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mediaViewport).toHaveClass(
      'canonical-post-media-viewport',
      'w-full',
    );
    expect(media).toHaveClass('canonical-post-media', 'min-w-0');
    expect(actions).toHaveClass('canonical-post-actions', 'min-w-0');
    expect(screen.getByRole('button', { name: 'Open media full screen' })).toBeInTheDocument();
  });

  it('uses the source return context for the detail back link', async () => {
    render(await ShowcaseDetailPage({
      params: Promise.resolve({ id: 'post-1' }),
      searchParams: Promise.resolve({
        from: 'unlocks',
        returnTo: '/marketplace?access=paid&resource=workflow',
      }),
    }));

    expect(screen.getByRole('link', { name: /back to marketplace/i })).toHaveAttribute(
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

    // The writing is the page: one document column carrying its own byline,
    // with no identity card printing the title a second time.
    expect(screen.queryByTestId('canonical-post-identity')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Three hooks that keep working' })).toBeInTheDocument();
    expect(screen.getAllByText('Three hooks that keep working')).toHaveLength(1);
    // Attribution sits in the masthead row; the note keeps the writing.
    expect(screen.getByTestId('canonical-post-head')).toHaveTextContent('@creator-name');
    expect(screen.getByTestId('canonical-post-head')).toHaveTextContent('Tip / note');

    // The chip bar is media furniture; a written note carries its own byline.
    expect(screen.queryByText(/shared post/i)).not.toBeInTheDocument();

    // Reddit reading order: the conversation flows in the document column,
    // directly under the writing, not in a full-width block below the rail.
    expect(
      within(screen.getByTestId('canonical-post-media')).getByTestId('canonical-post-comments')
    ).toBeInTheDocument();
  });

  it('pitches a text post recipe once, in the document column', async () => {
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

    // A text post pitches the recipe exactly once — in the document column,
    // after the conversation. The rail keeps a one-line pointer to it (not a
    // second pitch), so the recipe stays reachable under a long thread.
    expect(screen.queryByTestId('unlock-summary-link')).not.toBeInTheDocument();
    expect(screen.getByTestId('recipe-jump-link')).toHaveAttribute('href', '#recipe');
    expect(screen.getByTestId('recipe-jump-link')).toHaveTextContent('Free recipe');
    expect(
      within(screen.getByTestId('canonical-post-media')).getByTestId('canonical-post-recipe')
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('canonical-post-comments').compareDocumentPosition(
        screen.getByTestId('canonical-post-recipe')
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
