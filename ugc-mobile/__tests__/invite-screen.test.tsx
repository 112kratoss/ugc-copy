import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerState = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));

const harness = vi.hoisted(() => ({
  auth: {
    user: { id: 'creator-1' } as { id: string } | null,
    api: {
      getReferralOverview: vi.fn(),
      createReferralLink: vi.fn(),
    },
  },
  share: vi.fn(),
  copyToClipboard: vi.fn(),
}));

vi.mock('expo-router', () => ({ router: routerState }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Share: { share: harness.share, sharedAction: 'sharedAction' },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(name, props);
  return {
    CheckCircle2: icon('check-icon'),
    Copy: icon('copy-icon'),
    Gift: icon('gift-icon'),
    RotateCcw: icon('rotate-icon'),
    ShoppingBag: icon('bag-icon'),
    UserPlus: icon('user-plus-icon'),
    UsersRound: icon('users-icon'),
  };
});

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock('@/components/ui', () => {
  const text = ({ children }: MockProps) => React.createElement('text', null, children);
  const box = ({ children }: MockProps) => React.createElement('view', null, children);
  return {
    AppText: text,
    AppTextInput: (props: MockProps) => React.createElement('text-input', props),
    Card: box,
    Kicker: text,
    PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
    Screen: box,
    SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
    SectionTitle: ({ title, body }: { title: string; body?: string }) => React.createElement('view', null,
      React.createElement('text', null, title),
      body ? React.createElement('text', null, body) : null),
    StatusBlock: ({ title, body }: { title: string; body?: string }) => React.createElement('view', null,
      React.createElement('text', null, title),
      body ? React.createElement('text', null, body) : null),
  };
});

vi.mock('@/components/skeleton', () => ({ MetricGridSkeleton: () => null }));
vi.mock('@/lib/platform-glyphs', () => ({ ShareGlyph: (props: MockProps) => React.createElement('share-icon', props) }));
vi.mock('@/lib/copy-to-clipboard', () => ({ copyToClipboard: harness.copyToClipboard }));
vi.mock('@/lib/auth', () => ({ useAuth: () => harness.auth }));

import InviteScreen from '../app/invite';

// Not today's 5 / 5 / 30, so a number the screen made up would show.
const PROGRAM = { inviterPercent: 7, inviteeFirstPurchasePercent: 3, attributionWindowDays: 45 };

function overview(program: unknown) {
  return {
    success: true,
    program,
    code: 'creator1',
    shareUrl: 'https://magicbooklet.com/r/creator1',
    stats: { visits: 0, signups: 0, purchasers: 0, creditsEarned: 0, creditsReversed: 0 },
    recentRewards: [],
  };
}

function texts(tree: renderer.ReactTestRenderer) {
  return tree.root
    .findAll((node) => String(node.type) === 'text' && typeof node.props.children === 'string')
    .map((node) => node.props.children as string);
}

async function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(<QueryClientProvider client={queryClient}><InviteScreen /></QueryClientProvider>);
  });
  // React Query hands its results over on a timer.
  for (let tick = 0; tick < 4; tick += 1) {
    await renderer.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  return tree;
}

beforeEach(() => {
  harness.auth.user = { id: 'creator-1' };
  harness.auth.api.getReferralOverview.mockReset();
  harness.auth.api.createReferralLink.mockReset();
  harness.share.mockReset().mockResolvedValue({ action: 'sharedAction' });
  harness.copyToClipboard.mockReset().mockResolvedValue(undefined);
});

describe('Invite & Earn prints the program the server runs (03-7)', () => {
  it('takes every number from the referral overview', async () => {
    harness.auth.api.getReferralOverview.mockResolvedValue(overview(PROGRAM));
    const tree = await renderScreen();

    const values = texts(tree);
    expect(values).toContain('Friends get 3% bonus credits on their first top-up. You earn 7% bonus credits whenever they top up.');
    expect(values).toContain('Earn 7% in credits');
    expect(values).toContain('A new friend joins within 45 days of opening your link.');
    expect(values).toContain('They receive 3% bonus credits on their first verified credit-pack purchase.');
    expect(values).toContain('You receive 7% bonus credits on each verified credit-pack purchase they make.');
    expect(values.some((value) => /\b5%|\b30 days/.test(value))).toBe(false);

    const share = tree.root.find((node) => String(node.type) === 'primary-button' && node.props.label === 'Share invite');
    await renderer.act(async () => { (share.props.onPress as () => void)(); });
    expect(harness.share).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Try Magicbooklet and get 3% bonus credits on your first top-up.'),
    }));
    renderer.act(() => tree.unmount());
  });

  it('names no numbers while the overview has not answered', async () => {
    harness.auth.api.getReferralOverview.mockRejectedValue(new Error('Network request failed'));
    harness.auth.api.createReferralLink.mockResolvedValue({ success: true, code: 'creator1', shareUrl: 'https://magicbooklet.com/r/creator1' });
    const tree = await renderScreen();

    const values = texts(tree);
    expect(values).toContain('Friends get bonus credits on their first top-up. You earn bonus credits whenever they top up.');
    expect(values).toContain('Earn bonus credits');
    expect(values).toContain('A new friend joins after opening your link.');
    expect(values.some((value) => /\d+%|\d+ days/.test(value))).toBe(false);

    const copy = tree.root.find((node) => String(node.type) === 'secondary-button' && node.props.label === 'Copy referral link');
    await renderer.act(async () => { (copy.props.onPress as () => void)(); });
    expect(harness.copyToClipboard).toHaveBeenCalledWith(
      expect.stringContaining('Try Magicbooklet and get bonus credits on your first top-up.'),
      expect.any(String),
    );
    renderer.act(() => tree.unmount());
  });

  it('names no numbers to someone signed out, who has no program to read', async () => {
    harness.auth.user = null;
    const tree = await renderScreen();

    const values = texts(tree);
    expect(values).toContain('New users can receive bonus credits on their first top-up. Inviters earn bonus credits when referred friends top up.');
    expect(values.some((value) => /\d+%/.test(value))).toBe(false);
    expect(harness.auth.api.getReferralOverview).not.toHaveBeenCalled();
    renderer.act(() => tree.unmount());
  });
});
