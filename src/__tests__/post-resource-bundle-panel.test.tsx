import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PostResourceBundlePanel from '@/app/showcase/[id]/PostResourceBundlePanel';
import type { PostResourceBundleLockedPreview, PostResourceKind } from '@/lib/post-resource-bundles';

const { mockPush, mockRefresh, mockUpdateCredits, authState } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockUpdateCredits: vi.fn(),
  authState: {
    session: null as { access_token: string } | null,
    credits: null as number | null,
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRefresh,
  }),
}));

vi.mock('@/app/components/AuthProvider', () => ({
  useAuth: () => ({
    session: authState.session,
    credits: authState.credits,
    updateCredits: mockUpdateCredits,
  }),
}));

const promptOnlyPreview: PostResourceBundleLockedPreview = {
  resourceKinds: ['prompt'],
  attachmentPreviews: [],
  hasPrompt: true,
  hasNotes: false,
  hasWorkflow: false,
  hasRemix: false,
  updatedAt: '2026-04-25T10:00:00.000Z',
};

function renderPanel(overrides: Partial<Parameters<typeof PostResourceBundlePanel>[0]> = {}) {
  const resourceKinds: PostResourceKind[] = ['prompt'];

  return render(
    <PostResourceBundlePanel
      postId="post-1"
      title="Prompt unlock"
      summary="Unlock the prompt attached to this post."
      previewText=""
      priceLabel="$0.00"
      priceUsdCents={0}
      priceNote={null}
      isFree
      viewerCanAccess={false}
      viewerIsOwner={false}
      resourceKinds={resourceKinds}
      lockedPreview={promptOnlyPreview}
      salesCount={0}
      initialResources={null}
      {...overrides}
    />
  );
}

describe('PostResourceBundlePanel', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockRefresh.mockClear();
    mockUpdateCredits.mockClear();
    authState.session = null;
    authState.credits = null;
    vi.unstubAllGlobals();
  });

  it('keeps locked prompt-only unlocks compact with one open action', () => {
    renderPanel();

    expect(screen.getAllByRole('button', { name: /open free unlock/i })).toHaveLength(1);
    expect(screen.getByText(/the prompt text stays locked until this unlock is opened/i)).toBeInTheDocument();
    expect(screen.queryByText(/labels and file types can be shown publicly/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/secret prompt/i)).not.toBeInTheDocument();
  });

  it('shows owner prompt access with buyer-facing context', () => {
    renderPanel({
      viewerIsOwner: true,
      initialResources: {
        promptText: 'secret prompt',
        notesMarkdown: null,
        workflowShareUrl: null,
        attachments: [],
        allowRemix: false,
      },
    });

    expect(screen.getByText('secret prompt')).toBeInTheDocument();
    expect(screen.getByText(/owner preview\. buyers must unlock before seeing this/i)).toBeInTheDocument();
  });

  it('shows buyer trust terms without exposing locked content', () => {
    renderPanel({
      isFree: false,
      priceLabel: '₹189',
      priceUsdCents: 900,
      priceNote: 'Charged in INR for buyers in India.',
    });

    expect(screen.getByRole('button', { name: /pay with razorpay/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unlock with credits/i })).toBeInTheDocument();
    expect(screen.getByText(/razorpay: ₹189/i)).toBeInTheDocument();
    expect(screen.getByText(/credit cost: 900 credits/i)).toBeInTheDocument();
    expect(screen.getByText(/digital unlocks are final sale/i)).toBeInTheDocument();
    expect(screen.getByText(/do not resell, redistribute, or claim the raw bundle as your own/i)).toBeInTheDocument();
    expect(screen.queryByText(/secret prompt/i)).not.toBeInTheDocument();
  });

  it('unlocks paid post resources with credits and refreshes the revealed bundle', async () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1000;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/unlock-with-credits')) {
        return new Response(JSON.stringify({
          success: true,
          credits: 100,
        }));
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

    renderPanel({
      isFree: false,
      priceLabel: '₹189',
      priceUsdCents: 900,
    });

    fireEvent.click(screen.getByRole('button', { name: /unlock with credits/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/unlock-with-credits', expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-1',
        },
      }));
    });
    expect(mockUpdateCredits).toHaveBeenCalledWith(100);
    expect(await screen.findByText('revealed prompt')).toBeInTheDocument();
  });

  it('shows a credit top-up path when the viewer has insufficient credits', () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 120;

    renderPanel({
      isFree: false,
      priceLabel: '₹189',
      priceUsdCents: 900,
    });

    expect(screen.getByText(/120 credits available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unlock with credits/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: /buy credits/i })).toHaveAttribute('href', '/pricing');
  });

  it('keeps the Razorpay checkout route wired for paid post resources', async () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1000;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();

      if (url.endsWith('/order')) {
        return new Response(JSON.stringify({
          alreadyPurchased: true,
        }));
      }

      if (url.endsWith('/resource-bundle')) {
        return new Response(JSON.stringify({
          bundle: {
            viewerCanAccess: true,
            viewerIsOwner: false,
            resources: null,
          },
        }));
      }

      return new Response(JSON.stringify({ error: 'Unexpected request' }), { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({
      isFree: false,
      priceLabel: '₹189',
      priceUsdCents: 900,
    });

    fireEvent.click(screen.getByRole('button', { name: /pay with razorpay/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/posts/post-1/resource-bundle/order', expect.objectContaining({
        method: 'POST',
      }));
    });
  });
});
