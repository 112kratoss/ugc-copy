import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const routerState = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const paramsState = vi.hoisted(() => ({ params: {} as { code?: string; next?: string } }));
const authState = vi.hoisted(() => ({ api: {}, user: null, isLoading: false }));

vi.mock('expo-router', () => ({
  router: routerState,
  useLocalSearchParams: () => paramsState.params,
}));

vi.mock('react-native', () => ({
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(name, props);
  return {
    CheckCircle2: icon('check-icon'),
    Gift: icon('gift-icon'),
    Link2: icon('link-icon'),
    ShieldCheck: icon('shield-icon'),
    UserPlus: icon('user-plus-icon'),
  };
});

vi.mock('@/components/ui', () => {
  const text = ({ children }: MockProps) => React.createElement('text', null, children);
  const box = ({ children }: MockProps) => React.createElement('view', null, children);
  return {
    AppText: text,
    Card: box,
    Screen: box,
    PrimaryButton: ({ label }: { label: string }) => React.createElement('button', { label }),
    SecondaryButton: ({ label }: { label: string }) => React.createElement('button', { label }),
    SectionTitle: ({ title, body }: { title: string; body?: string }) => React.createElement('view', null,
      React.createElement('text', null, title),
      body ? React.createElement('text', null, body) : null),
    StatusBlock: ({ title, body }: { title: string; body?: string }) => React.createElement('view', null,
      React.createElement('text', null, title),
      body ? React.createElement('text', null, body) : null),
  };
});

vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

const attribution = vi.hoisted(() => ({
  capturePendingReferral: vi.fn(),
  claimPendingReferral: vi.fn(),
  getPendingReferral: vi.fn(async () => null as unknown),
  getRecentReferralClaimRecord: vi.fn(async () => null as unknown),
}));

// The storage and network half is the double; the copy helpers are the real ones.
vi.mock('@/lib/referral-attribution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/referral-attribution')>()),
  ...attribution,
  normalizeReferralCode: (value: string | null | undefined) => value?.trim() || null,
}));

import ReferralLandingScreen from '../app/r/[code]';

function texts(tree: renderer.ReactTestRenderer) {
  return tree.root
    .findAll((node) => String(node.type) === 'text' && typeof node.props.children === 'string')
    .map((node) => node.props.children as string);
}

describe('the invite landing screen', () => {
  // The app creates images, videos and motion; audio and workflows exist only
  // in the web's workflow builder, so the bonus line promised what it cannot do.
  it('promises only what the app creates', async () => {
    paramsState.params = {};
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<ReferralLandingScreen />);
      await Promise.resolve();
    });

    const values = texts(tree!);
    expect(values).toContain('Create images, videos and motion with your bonus credits.');
    expect(values.some((value) => /workflow|audio|prompts/i.test(value))).toBe(false);
    renderer.act(() => tree!.unmount());
  });
});

describe('the invite terms on the landing (03-7)', () => {
  // Not today's 5 / 5 / 30, so a number the screen made up would show.
  const program = { inviterPercent: 7, inviteeFirstPurchasePercent: 3, attributionWindowDays: 45 };

  beforeEach(() => {
    for (const mock of Object.values(attribution)) mock.mockReset();
    attribution.getPendingReferral.mockResolvedValue(null);
  });

  async function renderWith(params: { code?: string }) {
    paramsState.params = params;
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<ReferralLandingScreen />);
    });
    for (let tick = 0; tick < 4; tick += 1) {
      await renderer.act(async () => { await Promise.resolve(); });
    }
    return tree!;
  }

  it('prints the terms the visit answer carried', async () => {
    attribution.getRecentReferralClaimRecord.mockResolvedValue(null);
    attribution.capturePendingReferral.mockResolvedValue({
      keptEarlierInvite: false,
      pending: { code: 'creator1', capturedAt: '2026-10-15T07:00:00.000Z', visitToken: 'visit-1', program },
    });
    const tree = await renderWith({ code: 'creator1' });

    const values = texts(tree);
    expect(values).toContain('New users get 3% bonus credits on their first verified credit-pack purchase.');
    expect(values).toContain('3% first top-up bonus');
    expect(values).toContain('The first eligible invite opened within 45 days is used.');
    expect(values.some((value) => /\b5%|\b30 days/.test(value))).toBe(false);
    renderer.act(() => tree.unmount());
  });

  it('names the terms in "Invite applied" when it returns after sign-up', async () => {
    attribution.getRecentReferralClaimRecord.mockResolvedValue({
      code: 'creator1',
      claimedAt: '2026-10-15T07:00:00.000Z',
      response: { success: true, claimed: true },
      program,
    });
    const tree = await renderWith({ code: 'creator1' });

    expect(texts(tree)).toContain('Your 3% first top-up bonus will be added to your first verified credit-pack purchase.');
    expect(attribution.capturePendingReferral).not.toHaveBeenCalled();
    renderer.act(() => tree.unmount());
  });

  // Fast Refresh, or an <Activity> shown again, runs every effect once more over kept state.
  it('keeps the terms after every effect runs again', async () => {
    attribution.getRecentReferralClaimRecord.mockResolvedValue(null);
    attribution.capturePendingReferral.mockResolvedValue({
      keptEarlierInvite: false,
      pending: { code: 'creator1', capturedAt: '2026-10-15T07:00:00.000Z', visitToken: 'visit-1', program },
    });
    paramsState.params = { code: 'creator1' };
    const inActivity = (mode: 'visible' | 'hidden') => <React.Activity mode={mode}><ReferralLandingScreen /></React.Activity>;
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => { tree = renderer.create(inActivity('visible')); });
    await renderer.act(async () => { tree.update(inActivity('hidden')); });
    await renderer.act(async () => { tree.update(inActivity('visible')); });
    for (let tick = 0; tick < 4; tick += 1) {
      await renderer.act(async () => { await Promise.resolve(); });
    }

    expect(texts(tree)).toContain('3% first top-up bonus');
    expect(texts(tree)).toContain('Invite saved');
    renderer.act(() => tree.unmount());
  });

  it('names no numbers while the terms are unknown', async () => {
    attribution.getRecentReferralClaimRecord.mockResolvedValue(null);
    attribution.capturePendingReferral.mockResolvedValue({
      keptEarlierInvite: false,
      pending: { code: 'creator1', capturedAt: '2026-10-15T07:00:00.000Z', visitToken: 'visit-1', program: null },
    });
    const tree = await renderWith({ code: 'creator1' });

    const values = texts(tree);
    expect(values).toContain('New users get bonus credits on their first verified credit-pack purchase.');
    expect(values).toContain('First top-up bonus');
    expect(values).toContain('The first eligible invite you open is used.');
    expect(values.some((value) => /\d+%|\d+ days/.test(value))).toBe(false);
    renderer.act(() => tree.unmount());
  });
});
