import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MarketplaceAssetActions from '@/app/marketplace/[assetId]/MarketplaceAssetActions';

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

function renderActions(overrides: Partial<Parameters<typeof MarketplaceAssetActions>[0]> = {}) {
  return render(
    <MarketplaceAssetActions
      assetId="asset-1"
      type="prompt_pack"
      title="Prompt pack"
      priceLabel="₹189"
      priceUsdCents={900}
      priceNote="Charged in INR for buyers in India."
      isFree={false}
      viewerCanAccess={false}
      viewerIsSeller={false}
      promptPack={null}
      guideMarkdown={null}
      canImportWorkflow={false}
      {...overrides}
    />
  );
}

describe('MarketplaceAssetActions', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockRefresh.mockClear();
    mockUpdateCredits.mockClear();
    authState.session = null;
    authState.credits = null;
    vi.unstubAllGlobals();
  });

  it('renders equal Razorpay and credit choices for paid locked assets', () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1000;

    renderActions();

    expect(screen.getByRole('button', { name: /pay with razorpay/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /unlock with credits/i })).toBeInTheDocument();
    expect(screen.getByText(/razorpay: ₹189/i)).toBeInTheDocument();
    expect(screen.getByText(/credit cost: 900 credits/i)).toBeInTheDocument();
    expect(screen.getByText(/1,000 credits available/i)).toBeInTheDocument();
  });

  it('unlocks paid marketplace assets with credits and refreshes the route', async () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1000;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      credits: 100,
    })));
    vi.stubGlobal('fetch', fetchMock);

    renderActions();

    fireEvent.click(screen.getByRole('button', { name: /unlock with credits/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/marketplace/assets/asset-1/unlock-with-credits', expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-1',
        },
      }));
    });
    expect(mockUpdateCredits).toHaveBeenCalledWith(100);
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('keeps the Razorpay order route wired for paid marketplace assets', async () => {
    authState.session = { access_token: 'token-1' };
    authState.credits = 1000;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      alreadyPurchased: true,
    })));
    vi.stubGlobal('fetch', fetchMock);

    renderActions();

    fireEvent.click(screen.getByRole('button', { name: /pay with razorpay/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/marketplace/order', expect.objectContaining({
        method: 'POST',
      }));
    });
  });

  it('does not show paid choices for free, owned, or already-unlocked assets', () => {
    const { rerender } = renderActions({ isFree: true, priceUsdCents: 0, priceLabel: '$0.00' });

    expect(screen.queryByRole('button', { name: /pay with razorpay/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /get free access/i })).toBeInTheDocument();

    rerender(
      <MarketplaceAssetActions
        assetId="asset-1"
        type="prompt_pack"
        title="Prompt pack"
        priceLabel="₹189"
        priceUsdCents={900}
        priceNote={null}
        isFree={false}
        viewerCanAccess
        viewerIsSeller={false}
        promptPack={null}
        guideMarkdown={null}
        canImportWorkflow={false}
      />
    );
    expect(screen.queryByRole('button', { name: /pay with razorpay/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unlock with credits/i })).not.toBeInTheDocument();

    rerender(
      <MarketplaceAssetActions
        assetId="asset-1"
        type="prompt_pack"
        title="Prompt pack"
        priceLabel="₹189"
        priceUsdCents={900}
        priceNote={null}
        isFree={false}
        viewerCanAccess={false}
        viewerIsSeller
        promptPack={null}
        guideMarkdown={null}
        canImportWorkflow={false}
      />
    );
    expect(screen.queryByRole('button', { name: /pay with razorpay/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /unlock with credits/i })).not.toBeInTheDocument();
  });
});
