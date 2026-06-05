import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ShowcaseReelViewer from '@/app/showcase/ShowcaseReelViewer';
import type { ShowcaseFeedItem } from '@/lib/showcase';

vi.mock('next/link', () => ({
  default: ({
    href,
    prefetch,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: boolean;
    children: ReactNode;
  }) => (
    <a
      href={href}
      data-prefetch={prefetch === undefined ? undefined : String(prefetch)}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock('next/script', () => ({
  default: ({ id }: { id?: string }) => <script data-testid={id ?? 'next-script'} />,
}));

const { mockPush, mockUpdateCredits, authState } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockUpdateCredits: vi.fn(),
  authState: {
    session: null as { access_token: string } | null,
    credits: null as number | null,
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: authState.session,
    credits: authState.credits,
    updateCredits: mockUpdateCredits,
  }),
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
    span: ({ children, ...props }: HTMLAttributes<HTMLSpanElement>) => <span {...props}>{children}</span>,
  },
  useReducedMotion: () => false,
}));

vi.mock('@/app/components/PublicShareButton', () => ({
  default: ({ label, className }: { label?: string; className?: string }) => (
    <button type="button" className={className}>
      {label ?? 'Share'}
    </button>
  ),
}));

function createShowcaseItem(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-1',
    mediaUrl: 'https://example.com/image.jpg',
    mediaKind: 'image',
    model: 'nano-banana-2',
    title: 'Campaign Frame',
    prompt: 'A creator-style product shot by a bright window.',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 4,
    remixCount: 2,
    createdAt: '2026-03-28T10:00:00.000Z',
    creator: {
      id: 'creator-1',
      username: 'creator-name',
      name: 'Creator Name',
      avatar: null,
    },
    isSaved: false,
    sourceKind: 'magicbooklet',
    sourceTool: null,
    generationId: 'gen-1',
    asset: null,
    canRemix: false,
    ...overrides,
  };
}

const paidAsset: NonNullable<ShowcaseFeedItem['asset']> = {
  id: 'bundle-1',
  postId: 'post-1',
  title: 'Prompt pack',
  accessMode: 'paid',
  priceUsdCents: 900,
  priceQuote: {
    currency: 'USD',
    amountSubunits: 900,
    formatted: '$9.00',
    note: null,
  },
  previewText: 'Unlock the prompt and notes.',
  allowRemix: false,
  resourceKinds: ['prompt', 'notes'],
  itemCounts: { prompt: 1, note: 1 },
  lockedPreview: {
    resourceKinds: ['prompt', 'notes'],
    attachmentPreviews: [],
    itemCounts: { prompt: 1, note: 1 },
    itemPreviews: [
      {
        type: 'prompt',
        title: 'Prompt',
        role: 'primary',
        sectionId: null,
        remixUse: 'none',
      },
    ],
    hasPrompt: true,
    hasNotes: true,
    hasWorkflow: false,
    hasRemix: false,
    updatedAt: '2026-04-02T10:00:00.000Z',
  },
};

function renderPaidReel() {
  return render(
    <ShowcaseReelViewer
      isOpen
      items={[
        createShowcaseItem({
          id: 'post-1',
          title: 'Paid Frame',
          asset: paidAsset,
        }),
      ]}
      selectedItemId="post-1"
      savedItemIds={new Set()}
      savingItemIds={new Set()}
      accessToken={null}
      hasMoreItems={false}
      isLoadingMoreItems={false}
      onLoadMoreItems={vi.fn()}
      onClose={vi.fn()}
      onSelectItemId={vi.fn()}
      onToggleSave={vi.fn()}
      onRemix={vi.fn()}
      buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
    />
  );
}

describe('ShowcaseReelViewer pagination', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockUpdateCredits.mockClear();
    authState.session = null;
    authState.credits = null;
    vi.unstubAllGlobals();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('requests another page when next is pressed at the last loaded reel item', async () => {
    const loadMoreItems = vi.fn(async () => undefined);

    render(
      <ShowcaseReelViewer
        isOpen
        items={[
          createShowcaseItem({ id: 'post-1', title: 'First Frame' }),
          createShowcaseItem({ id: 'post-2', title: 'Last Loaded Frame' }),
        ]}
        selectedItemId="post-2"
        savedItemIds={new Set()}
        savingItemIds={new Set()}
        accessToken={null}
        hasMoreItems
        isLoadingMoreItems={false}
        onLoadMoreItems={loadMoreItems}
        onClose={vi.fn()}
        onSelectItemId={vi.fn()}
        onToggleSave={vi.fn()}
        onRemix={vi.fn()}
        buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
      />
    );

    fireEvent.keyDown(window, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(loadMoreItems).toHaveBeenCalledTimes(1);
    });
  });

  it('opens a compact cash or token choice inside the reel viewer', () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1200;

    renderPaidReel();

    const unlockButtons = screen.getAllByRole('button', { name: /unlock for \$9\.00/i });
    fireEvent.click(unlockButtons[0]);

    expect(screen.getByRole('button', { name: /pay with cash/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pay with tokens/i })).toBeInTheDocument();
    expect(screen.queryByText(/buyer trust/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/included after unlock/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/digital unlocks are final sale/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /unlock for \$9\.00/i })).not.toBeInTheDocument();
  });

  it('shows public generation recipes inline without purchase', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/resource-bundle')) {
        return new Response(JSON.stringify({
          bundle: {
            viewerCanAccess: true,
            viewerIsOwner: false,
            resources: {
              promptText: 'public recipe prompt',
              notesMarkdown: 'public recipe notes',
              workflowShareUrl: null,
              attachments: [],
              allowRemix: true,
              items: [
                {
                  type: 'prompt',
                  role: 'primary',
                  sectionId: null,
                  title: 'Prompt',
                  description: null,
                  textContent: 'public recipe prompt',
                  externalUrl: null,
                  storagePath: null,
                  contentType: null,
                  sizeBytes: null,
                  workflowSnapshot: null,
                  sortOrder: 0,
                  isPrimary: true,
                  remixUse: 'none',
                },
                {
                  type: 'reference_image',
                  role: 'style_reference',
                  sectionId: null,
                  title: 'Image input',
                  description: null,
                  textContent: null,
                  externalUrl: null,
                  storagePath: 'generated_images/user-1/reference.png',
                  contentType: 'image/png',
                  sizeBytes: null,
                  workflowSnapshot: null,
                  sortOrder: 1,
                  isPrimary: false,
                  remixUse: 'reference_only',
                },
                {
                  type: 'note',
                  role: 'other',
                  sectionId: null,
                  title: 'Notes',
                  description: null,
                  textContent: 'public recipe notes',
                  externalUrl: null,
                  storagePath: null,
                  contentType: null,
                  sizeBytes: null,
                  workflowSnapshot: null,
                  sortOrder: 2,
                  isPrimary: false,
                  remixUse: 'none',
                },
              ],
            },
          },
        }));
      }

      if (url.endsWith('/file-url')) {
        return new Response(JSON.stringify({
          success: true,
          signedUrl: 'https://signed.example.com/reference.png',
        }));
      }

      return new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ShowcaseReelViewer
        isOpen
        items={[
          createShowcaseItem({
            id: 'post-1',
            title: 'Public Recipe Frame',
            prompt: '',
            asset: {
              ...paidAsset,
              id: 'generation-recipe:post-1',
              title: 'Creation recipe',
              accessMode: 'free',
              priceUsdCents: 0,
              priceQuote: {
                currency: 'USD',
                amountSubunits: 0,
                formatted: '$0.00',
                note: null,
              },
              resourceKinds: ['prompt', 'files', 'notes', 'remix'],
              itemCounts: {
                prompt: 1,
                reference_image: 1,
                note: 1,
                remix_access: 1,
              },
            },
            canRemix: true,
          }),
        ]}
        selectedItemId="post-1"
        savedItemIds={new Set()}
        savingItemIds={new Set()}
        accessToken={null}
        hasMoreItems={false}
        isLoadingMoreItems={false}
        onLoadMoreItems={vi.fn()}
        onClose={vi.fn()}
        onSelectItemId={vi.fn()}
        onToggleSave={vi.fn()}
        onRemix={vi.fn()}
        buildDetailPath={(id, section) => section ? `/showcase/${id}#${section}` : `/showcase/${id}`}
      />
    );

    expect(await screen.findByText(/public recipe prompt/i)).toBeInTheDocument();
    expect(screen.getByText(/public recipe notes/i)).toBeInTheDocument();
    expect(screen.getByText(/image input/i)).toBeInTheDocument();
    expect(screen.getByText(/remix access is included/i)).toBeInTheDocument();
  });

  it('starts the existing cash checkout from the compact reel choice', async () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1200;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/order')) {
        return new Response(JSON.stringify({ success: true, alreadyPurchased: true }));
      }

      if (url.endsWith('/resource-bundle')) {
        return new Response(JSON.stringify({
          bundle: {
            viewerCanAccess: true,
            viewerIsOwner: false,
            resources: {
              promptText: 'revealed prompt',
              notesMarkdown: null,
              workflowShareUrl: null,
              attachments: [],
              allowRemix: false,
            },
          },
        }));
      }

      return new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPaidReel();
    fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
    fireEvent.click(screen.getByRole('button', { name: /pay with cash/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/order', expect.objectContaining({
        method: 'POST',
      }));
    });
  });

  it('unlocks with tokens and shows a compact success state', async () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1200;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/unlock-with-credits')) {
        return new Response(JSON.stringify({ success: true, credits: 300 }));
      }

      if (url.endsWith('/resource-bundle')) {
        return new Response(JSON.stringify({
          bundle: {
            viewerCanAccess: true,
            viewerIsOwner: false,
            resources: {
              promptText: 'revealed prompt',
              notesMarkdown: 'revealed notes',
              workflowShareUrl: null,
              attachments: [],
              allowRemix: false,
            },
          },
        }));
      }

      return new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPaidReel();
    fireEvent.click(screen.getAllByRole('button', { name: /unlock for \$9\.00/i })[0]);
    fireEvent.click(screen.getByRole('button', { name: /pay with tokens/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/unlock-with-credits', expect.objectContaining({
        method: 'POST',
      }));
    });
    expect(mockUpdateCredits).toHaveBeenCalledWith(300);
    expect(await screen.findByText('Unlocked')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /view unlocked details/i }));
    expect(screen.getByText(/revealed prompt/i)).toBeInTheDocument();
    expect(screen.getByText(/revealed notes/i)).toBeInTheDocument();
  });
});
