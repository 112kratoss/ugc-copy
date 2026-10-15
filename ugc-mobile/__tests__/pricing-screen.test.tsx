import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerState = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

const harness = vi.hoisted(() => ({
  auth: {
    isGuest: true,
    identityUserId: 'guest-1' as string | null,
    credits: 500 as number | null,
    api: {
      syncMobilePurchase: vi.fn(),
      restoreMobilePurchases: vi.fn(),
    },
    refreshProfile: vi.fn(),
    ensureGuestMergeTicket: vi.fn(),
  },
  iap: {
    configureIapForUser: vi.fn(),
    canDeviceMakePayments: vi.fn(),
    getCreditPackages: vi.fn(),
    isIapConfigured: vi.fn(),
    purchasePackage: vi.fn(),
  },
  platform: { OS: 'android' as 'android' | 'ios' },
}));

vi.mock('expo-router', () => ({ router: routerState }));

vi.mock('react-native', () => ({
  Platform: harness.platform,
  Pressable: ({ children, style: _style, ...props }: MockProps) => React.createElement(
    'pressable',
    props,
    typeof children === 'function' ? (children as (state: { pressed: boolean }) => React.ReactNode)({ pressed: false }) : children,
  ),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scroll-view', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
}));

vi.mock('lucide-react-native', () => ({
  CheckCircle2: (props: MockProps) => React.createElement('check-icon', props),
  ChevronRight: (props: MockProps) => React.createElement('chevron-right-icon', props),
  Circle: (props: MockProps) => React.createElement('circle-icon', props),
  History: (props: MockProps) => React.createElement('history-icon', props),
}));

vi.mock('@/components/ui', () => {
  const box = (name: string) => ({ children, ...props }: MockProps) => React.createElement(name, props, children);
  return {
    AppText: box('app-text'),
    Card: box('card'),
    Kicker: box('kicker'),
    Pill: (props: MockProps) => React.createElement('pill', props),
    PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
    Screen: box('screen'),
    SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
    SectionTitle: (props: MockProps) => React.createElement('section-title', props),
    StatusBlock: (props: MockProps) => React.createElement('status-block', props),
  };
});

vi.mock('@/components/guest-merge-banner', () => ({ GuestMergeBanner: () => null }));
vi.mock('@/lib/app-activity', () => ({ acquireActivityLock: () => () => undefined }));
vi.mock('@/lib/auth', () => ({ useAuth: () => harness.auth }));

vi.mock('@/lib/iap', async () => {
  const purchase = await import('../lib/iap-purchase');
  const entitlements = await import('../lib/iap-entitlements');
  return {
    configureIapForUser: (...args: unknown[]) => harness.iap.configureIapForUser(...args),
    canDeviceMakePayments: () => harness.iap.canDeviceMakePayments(),
    getCreditPackages: () => harness.iap.getCreditPackages(),
    isIapConfigured: (os: string) => harness.iap.isIapConfigured(os),
    purchasePackage: (...args: unknown[]) => harness.iap.purchasePackage(...args),
    isUserCancelledPurchase: purchase.isUserCancelledPurchase,
    resolveCreditEntitlement: entitlements.resolveCreditEntitlement,
  };
});

import PricingScreen from '../app/(tabs)/pricing';

const PACKAGES = [
  { product: { identifier: 'magicbooklet.credits.starter', priceString: '₹449' } },
  { product: { identifier: 'magicbooklet.credits.creator', priceString: '₹1,799' } },
  { product: { identifier: 'magicbooklet.credits.pro', priceString: '₹8,999' } },
];

function storeResult(transactionId: string | null) {
  return {
    provider: 'play_store',
    productId: 'magicbooklet.credits.creator',
    transactionId,
    customerInfo: {},
  };
}

async function flush() {
  // React Query hands its results over on a timer.
  for (let tick = 0; tick < 4; tick += 1) {
    await renderer.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderScreen(element: React.ReactElement = <PricingScreen />, queryClient = newQueryClient()) {
  let tree!: renderer.ReactTestRenderer;
  const wrap = (node: React.ReactElement) => <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>;
  await renderer.act(async () => {
    tree = renderer.create(wrap(element));
  });
  await flush();
  return { tree, queryClient, update: (node: React.ReactElement) => tree.update(wrap(node)) };
}

function buyButton(tree: renderer.ReactTestRenderer) {
  return tree.root.find((node) => String(node.type) === 'primary-button' && String(node.props.label).startsWith('Buy '));
}

function secondaryButton(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.find((node) => String(node.type) === 'secondary-button' && node.props.label === label);
}

function notices(tree: renderer.ReactTestRenderer) {
  return tree.root
    .findAll((node) => String(node.type) === 'status-block')
    .map((node) => ({ tone: node.props.tone, title: node.props.title, body: node.props.body }));
}

async function press(node: renderer.ReactTestInstance) {
  await renderer.act(async () => {
    (node.props.onPress as () => void)();
  });
  await flush();
}

beforeEach(() => {
  harness.platform.OS = 'android';
  Object.assign(harness.auth, { isGuest: true, identityUserId: 'guest-1', credits: 500 });
  harness.auth.api.syncMobilePurchase.mockReset().mockResolvedValue({ success: true, entitlement: 'credits', credits: 2500 });
  harness.auth.api.restoreMobilePurchases.mockReset().mockResolvedValue({
    success: true,
    credits: 500,
    restoredCreditPurchases: 0,
    alreadyProcessedCreditPurchases: 0,
    skipped: [],
    entitlements: [],
  });
  harness.auth.refreshProfile.mockReset().mockResolvedValue(undefined);
  harness.auth.ensureGuestMergeTicket.mockReset().mockResolvedValue(undefined);
  harness.iap.configureIapForUser.mockReset().mockResolvedValue(true);
  harness.iap.canDeviceMakePayments.mockReset().mockResolvedValue(true);
  harness.iap.getCreditPackages.mockReset().mockResolvedValue(PACKAGES);
  harness.iap.isIapConfigured.mockReset().mockReturnValue(true);
  harness.iap.purchasePackage.mockReset();
  routerState.push.mockReset();
});

describe('buying a credit pack (03-3)', () => {
  it('sells the contract packs at the store price, the featured one first in view', async () => {
    const { tree } = await renderScreen();

    expect(buyButton(tree).props.label).toBe('Buy 2,000 credits - ₹1,799');
    expect(buyButton(tree).props.disabled).toBe(false);
    const packBadges = tree.root
      .findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityRole === 'radio')
      .map((card) => card.findAll((node) => String(node.type) === 'pill').map((pill) => pill.props.label));
    // The contract's badge, on the Creator pack only.
    expect(packBadges).toEqual([[], ['Most popular'], []]);
  });

  it('calls a purchase the store is holding for approval pending, not failed', async () => {
    harness.iap.purchasePackage.mockRejectedValue(Object.assign(new Error('The payment is pending.'), {
      code: '20',
      userCancelled: false,
    }));
    const { tree } = await renderScreen();

    await press(buyButton(tree));

    expect(notices(tree)).toContainEqual({
      tone: 'neutral',
      title: 'Purchase status',
      body: 'Payment pending — credits arrive when the store approves it.',
    });
    expect(notices(tree).some((notice) => notice.title === 'Purchase not completed')).toBe(false);
    expect(harness.auth.api.syncMobilePurchase).not.toHaveBeenCalled();
    expect(harness.auth.api.restoreMobilePurchases).not.toHaveBeenCalled();
  });

  it('still calls a store failure a failure', async () => {
    harness.iap.purchasePackage.mockRejectedValue(Object.assign(new Error('The store is unavailable.'), { code: '2' }));
    const { tree } = await renderScreen();

    await press(buyButton(tree));

    expect(notices(tree)).toContainEqual({ tone: 'danger', title: 'Purchase not completed', body: 'The store is unavailable.' });
    expect(harness.auth.api.restoreMobilePurchases).not.toHaveBeenCalled();
    expect(harness.auth.ensureGuestMergeTicket).not.toHaveBeenCalled();
  });

  it('counts a store result without a transaction id as charged and settles it through the restore', async () => {
    harness.iap.purchasePackage.mockResolvedValue(storeResult(null));
    harness.auth.api.restoreMobilePurchases.mockResolvedValue({
      success: true,
      credits: 2500,
      restoredCreditPurchases: 1,
      alreadyProcessedCreditPurchases: 0,
      skipped: [],
      entitlements: [],
    });
    const { tree } = await renderScreen();

    await press(buyButton(tree));

    expect(harness.auth.api.syncMobilePurchase).not.toHaveBeenCalled();
    expect(harness.auth.api.restoreMobilePurchases).toHaveBeenCalledTimes(1);
    expect(notices(tree)).toContainEqual({
      tone: 'success',
      title: 'Purchase updated',
      body: 'Your purchase went through and your credits are now up to date.',
    });
    expect(notices(tree).some((notice) => notice.title === 'Purchase not completed')).toBe(false);
  });

  it('does not claim the credits landed when the restore after a charge settled nothing', async () => {
    harness.iap.purchasePackage.mockResolvedValue(storeResult('GPA.1234'));
    harness.auth.api.syncMobilePurchase.mockRejectedValue(new Error('Network request failed'));
    const { tree } = await renderScreen();

    await press(buyButton(tree));

    expect(harness.auth.api.restoreMobilePurchases).toHaveBeenCalledTimes(1);
    const notice = notices(tree).find((entry) => entry.title === 'Purchase status');
    expect(notice?.tone).toBe('neutral');
    expect(notice?.body).toContain('Your payment went through. Your credits have not landed yet');
    expect(notices(tree).some((entry) => entry.tone === 'success' || entry.tone === 'danger')).toBe(false);
  });

  it('counts the purchase landed when the balance moved, though the store webhook settled it first', async () => {
    harness.iap.purchasePackage.mockResolvedValue(storeResult('GPA.1234'));
    harness.auth.api.syncMobilePurchase.mockRejectedValue(new Error('Network request failed'));
    harness.auth.api.restoreMobilePurchases.mockResolvedValue({
      success: true,
      credits: 2500,
      restoredCreditPurchases: 0,
      alreadyProcessedCreditPurchases: 1,
      skipped: [],
      entitlements: [],
    });
    const { tree } = await renderScreen();

    await press(buyButton(tree));

    expect(notices(tree)).toContainEqual(expect.objectContaining({
      tone: 'success',
      body: 'Your purchase went through and your credits are now up to date.',
    }));
  });

  it('says the payment went through when the restore after a charge fails too', async () => {
    harness.iap.purchasePackage.mockResolvedValue(storeResult(null));
    harness.auth.api.restoreMobilePurchases.mockRejectedValue(new Error('Network request failed'));
    const { tree } = await renderScreen();

    await press(buyButton(tree));

    const notice = notices(tree).find((entry) => entry.title === 'Purchase status');
    expect(notice?.body).toContain('Your payment went through.');
    expect(notice?.body).toContain('You have not been charged twice.');
  });

  it("syncs a purchase, re-reads the balance and keeps the guest's merge ticket (02-7)", async () => {
    harness.iap.purchasePackage.mockResolvedValue(storeResult('GPA.1234'));
    const { tree } = await renderScreen();

    await press(buyButton(tree));

    expect(harness.auth.api.syncMobilePurchase).toHaveBeenCalledWith({
      provider: 'play_store',
      productId: 'magicbooklet.credits.creator',
      transactionId: 'GPA.1234',
      entitlement: { type: 'credits', productId: 'magicbooklet.credits.creator', credits: 2000 },
    });
    expect(harness.auth.refreshProfile).toHaveBeenCalled();
    expect(notices(tree)).toContainEqual({
      tone: 'success',
      title: 'Purchase updated',
      body: '2,000 credits are synced to your account.',
    });
    expect(harness.auth.ensureGuestMergeTicket).toHaveBeenCalledTimes(1);
  });

  it('keeps the ticket for a guest the store charged even when the sync did not land', async () => {
    harness.iap.purchasePackage.mockResolvedValue(storeResult(null));
    const { tree } = await renderScreen();

    await press(buyButton(tree));

    expect(harness.auth.ensureGuestMergeTicket).toHaveBeenCalledTimes(1);
  });

  it('mints no ticket for a registered account', async () => {
    Object.assign(harness.auth, { isGuest: false, identityUserId: 'user-1' });
    harness.iap.purchasePackage.mockResolvedValue(storeResult('GPA.1234'));
    const { tree } = await renderScreen();

    await press(buyButton(tree));

    expect(harness.auth.api.syncMobilePurchase).toHaveBeenCalledTimes(1);
    expect(harness.auth.ensureGuestMergeTicket).not.toHaveBeenCalled();
  });
});

describe('refresh and restore (03-10)', () => {
  it('refreshes the balance with a profile read and never a store restore', async () => {
    const { tree, queryClient } = await renderScreen();
    // What refreshProfile() does under the hood: the profile query answers.
    harness.auth.refreshProfile.mockImplementation(async () => {
      queryClient.setQueryData(['profile', 'guest-1'], { credits: 700 });
    });

    await press(secondaryButton(tree, 'Refresh credit balance'));

    expect(harness.auth.refreshProfile).toHaveBeenCalledTimes(1);
    expect(harness.auth.api.restoreMobilePurchases).not.toHaveBeenCalled();
    expect(notices(tree)).toContainEqual({
      tone: 'neutral',
      title: 'Balance refreshed',
      body: 'If a purchase has not appeared yet, tap Restore purchases.',
    });
  });

  it('says so when the balance could not be read', async () => {
    const { tree, queryClient } = await renderScreen();
    harness.auth.refreshProfile.mockImplementation(async () => {
      await queryClient.fetchQuery({
        queryKey: ['profile', 'guest-1'],
        queryFn: async () => { throw new Error('Network request failed'); },
      }).catch(() => undefined);
    });

    await press(secondaryButton(tree, 'Refresh credit balance'));

    expect(notices(tree)).toContainEqual({
      tone: 'danger',
      title: 'Could not refresh your balance',
      body: 'Check your connection, then try again.',
    });
  });

  it('restores from a separate action and shows a conflicting purchase it skipped', async () => {
    harness.auth.api.restoreMobilePurchases.mockResolvedValue({
      success: true,
      credits: 2500,
      restoredCreditPurchases: 1,
      alreadyProcessedCreditPurchases: 0,
      skipped: [{ transactionId: 'GPA.9', productId: 'magicbooklet.credits.starter', reason: 'transaction_conflict' }],
      entitlements: [],
    });
    const { tree } = await renderScreen();

    await press(secondaryButton(tree, 'Restore purchases'));

    expect(harness.auth.api.restoreMobilePurchases).toHaveBeenCalledTimes(1);
    expect(harness.auth.refreshProfile).toHaveBeenCalledTimes(1);
    expect(notices(tree)).toContainEqual({
      tone: 'success',
      title: 'Purchases restored',
      body: '1 purchase was added to your balance. 1 purchase (Starter) is already on file for another '
        + 'Magicbooklet account, so it was not added here.',
    });
    // The restore credited a guest, which now holds value.
    expect(harness.auth.ensureGuestMergeTicket).toHaveBeenCalledTimes(1);
  });

  it('names the store this phone uses in the restore hint', async () => {
    const android = await renderScreen();
    expect(secondaryButton(android.tree, 'Restore purchases').props.accessibilityHint)
      .toBe('Checks your Play Store purchases for credits that have not reached your balance');
    expect(String(secondaryButton(android.tree, 'Refresh credit balance').props.accessibilityHint)).not.toContain('App Store');
    renderer.act(() => android.tree.unmount());

    harness.platform.OS = 'ios';
    const ios = await renderScreen();
    expect(secondaryButton(ios.tree, 'Restore purchases').props.accessibilityHint)
      .toBe('Checks your App Store purchases for credits that have not reached your balance');
    renderer.act(() => ios.tree.unmount());
  });

  // Fast Refresh, or an <Activity> shown again, runs every effect once more over kept state.
  it('still sells and refreshes after every effect runs again', async () => {
    const inActivity = (mode: 'visible' | 'hidden') => <React.Activity mode={mode}><PricingScreen /></React.Activity>;
    const screen = await renderScreen(inActivity('visible'));

    await renderer.act(async () => { screen.update(inActivity('hidden')); });
    await renderer.act(async () => { screen.update(inActivity('visible')); });
    await flush();

    harness.iap.purchasePackage.mockResolvedValue(storeResult('GPA.1234'));
    await press(buyButton(screen.tree));
    expect(harness.auth.api.syncMobilePurchase).toHaveBeenCalledTimes(1);

    await press(secondaryButton(screen.tree, 'Refresh credit balance'));
    expect(harness.auth.api.restoreMobilePurchases).not.toHaveBeenCalled();
  });
});

// D6 (finding 03-11): what added the credits and what spent them, one tap from
// the balance, for a guest as for an account.
describe('the credit history beside the balance', () => {
  function historyLink(tree: renderer.ReactTestRenderer) {
    return tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Credit history');
  }

  it('opens the credit history from the balance card, saying it came from here', async () => {
    const { tree } = await renderScreen();
    const balanceCard = tree.root.find((node) => String(node.type) === 'card');
    const link = historyLink(tree);

    // Inside the balance's own card, as a button with a target to match.
    expect(balanceCard.findAll((node) => node === link)).toHaveLength(1);
    expect(link.props.accessibilityRole).toBe('button');
    expect(link.props.accessibilityHint).toBe('Lists what added credits to your balance and what spent them');
    expect(link.findAll((node) => String(node.type) === 'chevron-right-icon')).toHaveLength(1);

    await press(link);
    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/credit-history', params: { source: 'pricing' } });
    renderer.act(() => tree.unmount());
  });

  it('offers it to a registered account too', async () => {
    Object.assign(harness.auth, { isGuest: false, identityUserId: 'user-1' });
    const { tree } = await renderScreen();

    await press(historyLink(tree));
    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/credit-history', params: { source: 'pricing' } });
    renderer.act(() => tree.unmount());
  });
});

// 02-6: a guest bootstrap that failed is tried again while the app runs, so a
// device with no identity yet is told the screen updates by itself, where it
// was asked to check its connection and reopen the screen.
describe('a device whose session is still starting (02-6)', () => {
  const STARTING = {
    tone: undefined,
    title: 'Your session is still starting',
    body: 'Credit packs unlock once your session is ready. The app keeps trying in the background, and this screen updates by itself.',
  };

  it('says the app keeps trying, and unlocks the packs by itself once the identity lands', async () => {
    harness.auth.identityUserId = null;
    const screen = await renderScreen();

    expect(notices(screen.tree)).toContainEqual(STARTING);
    expect(notices(screen.tree).some((notice) => String(notice.body).includes('reopen'))).toBe(false);
    expect(buyButton(screen.tree).props.disabled).toBe(true);
    expect(harness.iap.configureIapForUser).not.toHaveBeenCalled();

    harness.auth.identityUserId = 'guest-1';
    await renderer.act(async () => { screen.update(<PricingScreen />); });
    await flush();

    expect(notices(screen.tree)).not.toContainEqual(STARTING);
    expect(harness.iap.configureIapForUser).toHaveBeenCalledWith('guest-1', 'android');
    expect(buyButton(screen.tree).props.disabled).toBe(false);
    renderer.act(() => screen.tree.unmount());
  });
});
