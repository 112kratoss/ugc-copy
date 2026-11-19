import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseDetailActions from '@/app/showcase/[id]/ShowcaseDetailActions';
import ShowcaseDetailBody from '@/app/showcase/[id]/ShowcaseDetailBody';
import type { ShowcasePostViewer } from '@/app/showcase/[id]/useShowcasePostViewer';
import type { StoredInviteHandoff } from '@/lib/invite-handoff';
import type { PublicPostDetail } from '@/lib/public-posts';

// Three parts of a post's page load with import() when they are drawn (`next/dynamic`, 2026-11-19):
// the not-found notice a block draws, the invite hand-off bar and the creator's Owner tools. That
// load can fail: a deploy renamed the chunk while the page was open, or the connection dropped.
// next/dynamic is a React.lazy in a Suspense with nothing to catch the failure, which reached the
// showcase folder's error.tsx: "Could not load Explore" in the place of the post a visitor came for,
// and a Retry that met the same failure at once (review of #884). Each part sits in a boundary of
// its own (`PostPagePartBoundary`) that keeps the failure to the part.

// In the app directory the bundler serves `next/dynamic` from next/dist/api/app-dynamic, whose loader
// is React.lazy with nothing to catch a failed load; left to itself vitest resolves the pages one,
// which hands the failure to the loading component, and the page would never meet the error. Every
// part the page loads fails, as the request for a chunk a deploy renamed does: the import() rejects.
// (A module mock whose factory throws is not steady, as the Alerts half's test found.)
vi.mock('next/dynamic', async () => {
  const { default: appDynamic } = await import('next/dist/api/app-dynamic');
  return {
    default: (_loader: unknown, options?: Parameters<typeof appDynamic>[1]) => (
      appDynamic(() => Promise.reject(new Error(CHUNK_ERROR)), options)
    ),
  };
});

const viewer = vi.hoisted(() => ({ current: null as ShowcasePostViewer | null }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/showcase/post-1',
}));

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: null, user: null, isLoading: false }),
}));

// Who is looking, as each test sets it: the page's own read of the viewer is not what is tested here.
vi.mock('@/app/showcase/[id]/useShowcasePostViewer', () => ({
  useShowcasePostViewer: () => viewer.current,
  ShowcaseSearchParamsReporter: () => null,
}));

vi.mock('@/components/PostComments', () => ({
  default: () => <div data-testid="post-comments-component">Comments</div>,
}));

const CHUNK_ERROR = 'Loading chunk post-page-part failed.';

const SHARED_INVITE: StoredInviteHandoff = { code: 'ABC234', kind: 'shared_link', path: '/showcase/post-1', preview: false };

/** A text post: no media, its writing under its title. */
const DETAIL = {
  id: 'post-1',
  generationId: null,
  visibility: 'public',
  mediaUrl: null,
  mediaKind: null,
  mediaItems: [],
  model: null,
  title: 'A note worth keeping',
  description: '',
  prompt: '',
  body: 'The whole note, which a visitor came to read.',
  category: 'text',
  postFormat: 'text',
  creationMode: null,
  saveCount: 0,
  commentCount: 0,
  remixCount: 0,
  shareCount: 0,
  shareVisitCount: 0,
  createdAt: '2026-11-01T10:00:00.000Z',
  sourceKind: 'external',
  sourceTool: null,
  isNsfw: false,
  nsfwRevealed: false,
  creator: { id: 'creator-1', username: 'mira', name: 'Mira', avatar: null },
  resourceBundle: null,
  canRemix: false,
  remixCapability: 'none',
  remixTarget: null,
  remixCredit: null,
  generationSetup: null,
} as unknown as PublicPostDetail;

function aVisitor(overrides: Partial<ShowcasePostViewer> = {}): ShowcasePostViewer {
  const noRemix = { canRemix: false, remixCapability: 'none' as const, remixTarget: null };
  return {
    viewerUserId: null,
    viewerIsOwner: false,
    ownership: 'other',
    visibility: 'public',
    bundle: null,
    bundlePanelKey: 'visitor:page',
    bundleReadFailed: false,
    creatorCheckOverdue: false,
    retryCreatorRecipe: () => undefined,
    lockedViewer: false,
    recipeChecking: false,
    remix: noRemix,
    creatorRemix: noRemix,
    blocked: false,
    remixCredit: null,
    returnContext: { source: 'unnamed', href: '/', label: 'Back' },
    deliveryId: null,
    reportSearch: () => undefined,
    inviteHandoff: null,
    applyBundleAccess: () => undefined,
    markCreatorBlocked: () => undefined,
    ...overrides,
  };
}

function renderPost() {
  return render(
    <ShowcaseDetailBody
      detail={DETAIL}
      shareDescription="A note worth keeping"
      madeWithLabel={null}
      renderedAt={Date.parse('2026-11-02T10:00:00.000Z')}
    />,
  );
}

describe("a post page's parts loaded with import() when their load fails", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  const reload = vi.fn();
  // Where Sentry's global handler hears an error (jsdom has no reportError of its own).
  const reportError = vi.fn();

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    reload.mockReset();
    reportError.mockReset();
    viewer.current = aVisitor();
    vi.stubGlobal('reportError', reportError);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    consoleError.mockRestore();
  });

  it('keeps the post a shared link brought a visitor to when the invite bar does not load, drawing no bar', async () => {
    viewer.current = aVisitor({ inviteHandoff: SHARED_INVITE });
    renderPost();

    await waitFor(() => expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: CHUNK_ERROR })));
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to load the invite hand-off bar:',
      expect.objectContaining({ message: CHUNK_ERROR }),
    );
    // The post stands, and nothing stands where the bar would have.
    expect(screen.getByRole('heading', { level: 1, name: 'A note worth keeping' })).toBeInTheDocument();
    expect(screen.getByText('The whole note, which a visitor came to read.')).toBeInTheDocument();
    expect(screen.getByTestId('canonical-post-actions')).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Your invite' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not load/)).not.toBeInTheDocument();
  });

  it("keeps a blocked post hidden, on the notice's empty page, when the notice does not load", async () => {
    viewer.current = aVisitor({ viewerUserId: 'reader-1', blocked: true });
    const { container } = renderPost();

    await waitFor(() => expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: CHUNK_ERROR })));
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to load the not-found notice of a blocked post:',
      expect.objectContaining({ message: CHUNK_ERROR }),
    );
    // The post stays hidden: the notice's page, empty, is all there is.
    expect(screen.queryByRole('heading', { name: 'A note worth keeping' })).not.toBeInTheDocument();
    expect(screen.queryByText('The whole note, which a visitor came to read.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('showcase-post-unavailable')).not.toBeInTheDocument();
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toHaveClass('ui-page', 'ui-page-ambient');
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });

  it("says the creator's Owner tools did not load, with a reload, and keeps the rest of the rail", async () => {
    vi.stubGlobal('location', { reload });
    render(
      <ShowcaseDetailActions
        postId="post-1"
        generationId="gen-1"
        title="Sunset study"
        creatorUsername="mira"
        visibility="public"
        ownerTools="ready"
        hasResourceBundle={false}
      />,
    );

    const tools = screen.getByText('Owner tools').closest('details') as HTMLDetailsElement;
    expect(await within(tools).findByText('The Owner tools did not load.')).toBeInTheDocument();
    expect(within(tools).queryByRole('link', { name: 'Edit post' })).not.toBeInTheDocument();
    // The rest of the rail stands.
    expect(screen.getByRole('link', { name: 'View creator' })).toHaveAttribute('href', '/creators/mira');
    expect(screen.getByRole('link', { name: /Create your own/ })).toHaveAttribute('href', '/create');
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to load the Owner tools:',
      expect.objectContaining({ message: CHUNK_ERROR }),
    );
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: CHUNK_ERROR }));

    fireEvent.click(within(tools).getByRole('button', { name: 'Reload page' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
