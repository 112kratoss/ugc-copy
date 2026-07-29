import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPostReferenceForShowcaseIdMock = vi.fn();
const getPublicPostDetailMock = vi.fn();
const getServerAuthStateMock = vi.fn();
const recordPostShareEventMock = vi.fn();
const notFoundMock = vi.fn();
const redirectMock = vi.fn();

vi.mock('next/navigation', () => ({
  notFound: () => notFoundMock(),
  redirect: (path: string) => redirectMock(path),
  useRouter: () => ({ back: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/lib/public-posts', () => ({
  getPostReferenceForShowcaseId: (id: string) => getPostReferenceForShowcaseIdMock(id),
  getPublicPostDetail: (id: string, options?: unknown) => getPublicPostDetailMock(id, options),
  getPublicPostMetaDescription: () => 'meta description',
}));

vi.mock('@/lib/post-share-events', () => ({
  recordPostShareEvent: (input: unknown) => recordPostShareEventMock(input),
}));

vi.mock('@/lib/supabase-server', () => ({
  getServerAuthState: () => getServerAuthStateMock(),
}));

vi.mock('@/app/components/RouteAuthBoundary', () => ({
  RequestHintedOptionalAuth: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="auth-boundary">{children}</div>
  ),
}));

vi.mock('@/app/showcase/[id]/ShowcaseDetailActions', () => ({
  default: () => <div data-testid="detail-actions" />,
}));

vi.mock('@/app/showcase/[id]/PostResourceBundlePanel', () => ({
  default: () => <div data-testid="resource-bundle-panel" />,
}));

vi.mock('@/app/components/PostComments', () => ({
  default: () => <div data-testid="post-comments" />,
}));

function buildDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    generationId: 'gen-1',
    title: 'Moody Bathroom Portrait Study',
    description: 'A soft-lit bathroom portrait reference.',
    body: '',
    prompt: 'a soft-lit portrait',
    category: 'image',
    postFormat: 'media',
    mediaUrl: 'https://cdn.example.test/post-1.png',
    mediaKind: 'image',
    mediaItems: [],
    model: 'nano-banana-2',
    sourceTool: null,
    visibility: 'public',
    createdAt: '2026-07-20T10:00:00.000Z',
    saveCount: 3,
    remixCount: 0,
    shareCount: 0,
    shareVisitCount: 0,
    commentCount: 2,
    canRemix: true,
    resourceBundle: null,
    creator: { id: 'creator-1', username: 'fluffy', name: 'Fluffy', avatar: null },
    ...overrides,
  };
}

describe('Intercepted showcase detail overlay', () => {
  beforeEach(() => {
    vi.resetModules();
    getPostReferenceForShowcaseIdMock.mockReset();
    getPublicPostDetailMock.mockReset();
    getServerAuthStateMock.mockReset();
    recordPostShareEventMock.mockReset();
    notFoundMock.mockReset();
    redirectMock.mockReset();
    getServerAuthStateMock.mockResolvedValue({
      session: { user: { id: 'viewer-1' }, access_token: 'token-1' },
      credits: 10,
    });
  });

  it('renders the post inside a modal dialog with its own auth boundary', async () => {
    getPostReferenceForShowcaseIdMock.mockResolvedValue({ id: 'post-1' });
    getPublicPostDetailMock.mockResolvedValue(buildDetail());
    const { default: InterceptedShowcaseDetailPage } = await import('@/app/@modal/(.)showcase/[id]/page');

    render(await InterceptedShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

    expect(screen.getByRole('dialog', { name: 'Moody Bathroom Portrait Study' })).toBeInTheDocument();
    expect(screen.getByTestId('auth-boundary')).toBeInTheDocument();
    expect(screen.getByTestId('canonical-post-identity')).toBeInTheDocument();
    expect(screen.getByTestId('canonical-post-media')).toBeInTheDocument();
    expect(screen.getByTestId('post-comments')).toBeInTheDocument();
    expect(getPublicPostDetailMock).toHaveBeenCalledWith('post-1', expect.objectContaining({
      viewerUserId: 'viewer-1',
    }));
  });

  it('does not record a share visit — an overlay is not a shared-link arrival', async () => {
    getPostReferenceForShowcaseIdMock.mockResolvedValue({ id: 'post-1' });
    getPublicPostDetailMock.mockResolvedValue(buildDetail());
    const { default: InterceptedShowcaseDetailPage } = await import('@/app/@modal/(.)showcase/[id]/page');

    render(await InterceptedShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

    expect(recordPostShareEventMock).not.toHaveBeenCalled();
  });

  it('omits the page-only return link, leaving Close as the way out', async () => {
    getPostReferenceForShowcaseIdMock.mockResolvedValue({ id: 'post-1' });
    getPublicPostDetailMock.mockResolvedValue(buildDetail());
    const { default: InterceptedShowcaseDetailPage } = await import('@/app/@modal/(.)showcase/[id]/page');

    render(await InterceptedShowcaseDetailPage({ params: Promise.resolve({ id: 'post-1' }) }));

    expect(screen.queryByRole('link', { name: /Back to/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close post' })).toBeInTheDocument();
  });

  it('reports an unavailable post in the panel instead of replacing the list behind it', async () => {
    getPostReferenceForShowcaseIdMock.mockResolvedValue(null);
    const { default: InterceptedShowcaseDetailPage } = await import('@/app/@modal/(.)showcase/[id]/page');

    render(await InterceptedShowcaseDetailPage({ params: Promise.resolve({ id: 'missing' }) }));

    expect(screen.getByText('This post is unavailable')).toBeInTheDocument();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it('renders a legacy generation id in place rather than redirecting the overlay', async () => {
    getPostReferenceForShowcaseIdMock.mockResolvedValue({ id: 'post-1' });
    getPublicPostDetailMock.mockResolvedValue(buildDetail());
    const { default: InterceptedShowcaseDetailPage } = await import('@/app/@modal/(.)showcase/[id]/page');

    render(await InterceptedShowcaseDetailPage({ params: Promise.resolve({ id: 'gen-1' }) }));

    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Moody Bathroom Portrait Study' })).toBeInTheDocument();
  });
});
